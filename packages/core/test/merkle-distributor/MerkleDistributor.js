const { MerkleTree } = require("../../../merkle-distributor/src/merkleTree");

const SamplePayouts = require("./SamplePayout.json");

const { toBN, toWei, utf8ToHex } = web3.utils;
const { MAX_UINT_VAL, didContractThrow } = require("@uma/common");

// Tested Contract
const MerkleDistributor = artifacts.require("MerkleDistributor");
const Timer = artifacts.require("Timer");
const Token = artifacts.require("ExpandedERC20");

let merkleDistributor, timer, rewardToken, rewardRecipients, merkleTree, rewardLeafs, leaf, claimerProof;

// For a recipeint object, create the leaf to be part of the merkle tree. The leaf is simply a hash of the concatenation
// of all fields within the payout object for the recipient.
const createLeaf = recipient => {
  // The recipient must contain all the keys to correctly generate the leaf hash. If anything is undefined we'll have nonsensical problems.
  assert.isTrue(
    Object.keys(recipient).every(val =>
      ["windowIndex", "account", "amount", "metaData", "rewardToken", "windowStart", "windowEnd"].includes(val)
    ),
    "recipient must contain all required keys"
  );
  return web3.utils.soliditySha3(
    { t: "uint256", v: recipient.windowIndex },
    { t: "address", v: recipient.account },
    { t: "uint256", v: recipient.amount },
    { t: "string", v: recipient.metaData },
    { t: "address", v: recipient.rewardToken },
    { t: "uint256", v: recipient.windowStart },
    { t: "uint256", v: recipient.windowEnd }
  );
};

// Generate payouts to be used in tests using the SamplePayouts file.
const createRewardRecipientsFromSampleData = (SamplePayouts, windowIndex, windowStart, windowEnd) => {
  return Object.keys(SamplePayouts.exampleRecipients).map(recipientAddress => {
    return {
      account: recipientAddress,
      amount: SamplePayouts.exampleRecipients[recipientAddress].amount,
      metaData: SamplePayouts.exampleRecipients[recipientAddress].metaData,
      windowIndex,
      windowStart,
      windowEnd,
      rewardToken: rewardToken.address
    };
  });
};

contract("ExpiringMultiParty", function(accounts) {
  let contractCreator = accounts[0];
  let rando = accounts[1];

  beforeEach(async () => {
    timer = await Timer.deployed();
    merkleDistributor = await MerkleDistributor.new(timer.address);

    rewardToken = await Token.new("UMA KPI Options July 2021", "uKIP-JUL", 18, { from: contractCreator });
    await rewardToken.addMember(1, contractCreator, { from: contractCreator });
    await rewardToken.mint(contractCreator, toWei("10000000"), { from: contractCreator });
  });
  describe("Basic lifecycle", function() {
    it("Can create a simple tree, seed the distributor and claim rewards", async function() {
      const currentTime = await timer.getCurrentTime();
      const rewardAmount = toBN(toWei("100"));
      // Create a an array of reward recipients. Each object within the array represents the payout for one account. The
      // metaData is an arbitrary string that can be appended to each recipient to add additional information about the payouts.
      rewardRecipients = [
        {
          account: accounts[3],
          amount: rewardAmount.muln(1).toString(),
          metaData: "Liquidity mining, Developer mining, UMA governance"
        },
        {
          account: accounts[4],
          amount: rewardAmount.muln(2).toString(),
          metaData: "Liquidity mining, Developer mining"
        },
        {
          account: accounts[5],
          amount: rewardAmount.muln(3).toString(),
          metaData: "Liquidity mining"
        }
      ];

      const windowIndex = 0; // Each window has a unique index
      // In this example, each recipient will have their rewards vest instantly once. Each recipient will get the `amount`
      // of `rewardToken` when claiming their rewards.
      const commonFields = {
        windowIndex,
        rewardToken: rewardToken.address,
        windowStart: currentTime,
        windowEnd: currentTime
      };

      // Append the commonFields to each rewardRecipient
      rewardRecipients = rewardRecipients.map((r, index) => {
        return { ...rewardRecipients[index], ...commonFields };
      });

      // Generate leafs for each recipient. This is simply the hash of each component of the payout from above.
      rewardLeafs = rewardRecipients.map(item => ({ ...item, leaf: createLeaf(item) }));

      // Build the merkle tree from an array of hashes from each recipient.
      merkleTree = new MerkleTree(rewardLeafs.map(item => item.leaf));

      // Seed the merkleDistributor with the root of the tree and additional information.
      await rewardToken.approve(merkleDistributor.address, MAX_UINT_VAL, { from: contractCreator });
      await merkleDistributor.setWindowMerkleRoot(
        windowIndex,
        toWei("600"),
        currentTime,
        currentTime,
        rewardToken.address,
        merkleTree.getRoot()
      );

      // A member of the tree should now be able to claim rewards.
      leaf = rewardLeafs[0];
      const claimerBalanceBefore = await rewardToken.balanceOf(leaf.account);
      claimerProof = merkleTree.getProof(leaf.leaf);

      // Claim the rewards, providing the information needed to re-build the tree & verify the proof.
      await merkleDistributor.claimWindow(leaf.windowIndex, leaf.account, leaf.amount, leaf.metaData, claimerProof);
      // Their balance should have increased by the amount of the reward.
      assert.equal(
        (await rewardToken.balanceOf(leaf.account)).toString(),
        claimerBalanceBefore.add(toBN(leaf.amount)).toString()
      );
    });
  });
  describe("Single window", function() {
    // For each test in the single window, load in the SampleMerlePayouts, generate a tree and set it in the distributor.
    beforeEach(async function() {
      const windowIndex = 0;
      const currentTime = await timer.getCurrentTime();

      rewardRecipients = createRewardRecipientsFromSampleData(SamplePayouts, windowIndex, currentTime, currentTime);

      // Generate leafs for each recipient. This is simply the hash of each component of the payout from above.
      rewardLeafs = rewardRecipients.map(item => ({ ...item, leaf: createLeaf(item) }));
      merkleTree = new MerkleTree(rewardLeafs.map(item => item.leaf));

      // Seed the merkleDistributor with the root of the tree and additional information.
      await rewardToken.approve(merkleDistributor.address, MAX_UINT_VAL, { from: contractCreator });
      await merkleDistributor.setWindowMerkleRoot(
        windowIndex,
        SamplePayouts.totalRewardsDistributed,
        currentTime,
        currentTime,
        rewardToken.address,
        merkleTree.getRoot()
      );

      leaf = rewardLeafs[0];
      claimerProof = merkleTree.getProof(leaf.leaf);
    });
    it("Can claim rewards on another EOA's behalf", async function() {
      // Can correctly claim on the EOAs behalf.
      const claimerBalanceBefore = await rewardToken.balanceOf(leaf.account);
      await merkleDistributor.claimWindow(leaf.windowIndex, leaf.account, leaf.amount, leaf.metaData, claimerProof, {
        from: rando
      });
      // The EOA balance should have increased by the amount of the reward.
      assert.equal(
        (await rewardToken.balanceOf(leaf.account)).toString(),
        claimerBalanceBefore.add(toBN(leaf.amount)).toString()
      );
    });
    it("Can not double claim rewards", async function() {
      // Claim rewards for the EOA.
      await merkleDistributor.claimWindow(leaf.windowIndex, leaf.account, leaf.amount, leaf.metaData, claimerProof, {
        from: rando
      });
      // Can not re-claim rewards for the EOA.
      assert(
        await didContractThrow(
          merkleDistributor.claimWindow(leaf.windowIndex, leaf.account, leaf.amount, leaf.metaData, claimerProof, {
            from: rando
          })
        )
      );
    });
    it("Can not claim rewards if not part of the tree", async function() {
      // Can not claim the recipient rewards as your own. Set the account in the claim component to `rando`, using
      // the rest of the valid proof.
      assert(
        await didContractThrow(
          merkleDistributor.claimWindow(leaf.windowIndex, rando, leaf.amount, leaf.metaData, claimerProof, {
            from: rando
          })
        )
      );
    });
    it("Can not claim rewards with invalid data", async function() {
      const invalidProof = [utf8ToHex("0x")];
      assert(
        await didContractThrow(
          merkleDistributor.claimWindow(leaf.windowIndex, leaf.account, leaf.amount, leaf.metaData, invalidProof, {
            from: rando
          })
        )
      );
    });
    it("Can not claim rewards with invalid proof", async function() {});
  });

  describe("Multiple window", function() {
    beforeEach(async function() {});
    it("Can not re-use window index", async function() {});
    it("can not claim from invalid window", async function() {});
    it("Can claim from multiple windows in one transaction", async function() {});
  });
  describe("Vesting over a window", function() {
    beforeEach(async function() {});
    it("Can not claim if before vesting starts", async function() {});
    it("Can claim correct number of rewards mid vesting", async function() {});
    it("Can claim all rewards post vesting", async function() {});
  });
});
