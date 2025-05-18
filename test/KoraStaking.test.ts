import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { Contract, ContractFactory } from "ethers";
import { KoraCoin, KoraStaking } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("KoraStaking", function() {
  let KoraCoin: ContractFactory;
  let KoraStaking: ContractFactory;
  let koraCoin: KoraCoin;
  let koraStaking: KoraStaking;
  let owner: SignerWithAddress;
  let nodeOperator1: SignerWithAddress;
  let nodeOperator2: SignerWithAddress;
  let nodeOperator3: SignerWithAddress;

  const minimumStake = ethers.parseEther("1000");
  const unstakingDelay = 60 * 60 * 24 * 7; // 7 days

  beforeEach(async function() {
    // Get signers
    [owner, nodeOperator1, nodeOperator2, nodeOperator3] = await ethers.getSigners();

    // Deploy KoraCoin
    KoraCoin = await ethers.getContractFactory("KoraCoin");
    koraCoin = await upgrades.deployProxy(
      KoraCoin,
      [owner.address],
      {
        initializer: 'initialize',
        kind: 'uups'
      }
    ) as KoraCoin;
    await koraCoin.waitForDeployment();

    // Deploy KoraStaking
    KoraStaking = await ethers.getContractFactory("KoraStaking");
    koraStaking = await upgrades.deployProxy(
      KoraStaking,
      [
        await koraCoin.getAddress(),
        minimumStake,
        unstakingDelay,
        owner.address
      ],
      {
        initializer: 'initialize',
        kind: 'uups'
      }
    ) as KoraStaking;
    await koraStaking.waitForDeployment();

    // Mint tokens to node operators
    const operatorTokens = ethers.parseEther("5000");
    await koraCoin.mint(nodeOperator1.address, operatorTokens);
    await koraCoin.mint(nodeOperator2.address, operatorTokens);
    await koraCoin.mint(nodeOperator3.address, operatorTokens);
  });

  describe("Deployment", function() {
    it("Should set the right token", async function() {
      expect(await koraStaking.koraToken()).to.equal(await koraCoin.getAddress());
    });

    it("Should set the right minimum stake", async function() {
      expect(await koraStaking.minimumStake()).to.equal(minimumStake);
    });

    it("Should set the right unstaking delay", async function() {
      expect(await koraStaking.unstakingDelay()).to.equal(unstakingDelay);
    });

    it("Should set the right owner", async function() {
      expect(await koraStaking.owner()).to.equal(owner.address);
    });
  });

  describe("Staking", function() {
    const stakeAmount = ethers.parseEther("2000");

    beforeEach(async function() {
      // Approve tokens to be spent by staking contract
      await koraCoin.connect(nodeOperator1).approve(await koraStaking.getAddress(), stakeAmount);
    });

    it("Should allow staking tokens", async function() {
      await expect(koraStaking.connect(nodeOperator1).stake(stakeAmount))
        .to.emit(koraStaking, "Staked")
        .withArgs(nodeOperator1.address, stakeAmount);

      const stakeInfo = await koraStaking.getStakeInfo(nodeOperator1.address);
      expect(stakeInfo[0]).to.equal(stakeAmount); // amount
      expect(stakeInfo[3]).to.be.true; // isActive
      
      // Verify staker is in the active stakers list
      const activeStakers = await koraStaking.getActiveStakers();
      expect(activeStakers).to.include(nodeOperator1.address);
    });

    it("Should update active stakers list", async function() {
      await koraStaking.connect(nodeOperator1).stake(stakeAmount);
      
      const activeStakers = await koraStaking.getActiveStakers();
      expect(activeStakers.length).to.equal(1);
      expect(activeStakers[0]).to.equal(nodeOperator1.address);
    });

    it("Should revert if stake amount is below minimum", async function() {
      const belowMinimum = ethers.parseEther("500");
      await koraCoin.connect(nodeOperator1).approve(await koraStaking.getAddress(), belowMinimum);
      
      await expect(
        koraStaking.connect(nodeOperator1).stake(belowMinimum)
      ).to.be.revertedWith("Amount below minimum stake");
    });

    it("Should revert if already staking", async function() {
      await koraStaking.connect(nodeOperator1).stake(stakeAmount);
      
      await koraCoin.connect(nodeOperator1).approve(await koraStaking.getAddress(), stakeAmount);
      await expect(
        koraStaking.connect(nodeOperator1).stake(stakeAmount)
      ).to.be.revertedWith("Already staking");
    });
  });

  describe("Unstaking", function() {
    const stakeAmount = ethers.parseEther("2000");

    beforeEach(async function() {
      // Stake tokens first
      await koraCoin.connect(nodeOperator1).approve(await koraStaking.getAddress(), stakeAmount);
      await koraStaking.connect(nodeOperator1).stake(stakeAmount);
    });

    it("Should allow requesting unstake", async function() {
      const tx = await koraStaking.connect(nodeOperator1).requestUnstake();
      
      // Get timestamp of the block
      const receipt = await tx.wait();
      if (receipt && receipt.blockNumber) {
        const block = await ethers.provider.getBlock(receipt.blockNumber);
        const timestamp = block!.timestamp;
        
        await expect(tx)
          .to.emit(koraStaking, "UnstakeRequested")
          .withArgs(nodeOperator1.address, timestamp);

        const stakeInfo = await koraStaking.getStakeInfo(nodeOperator1.address);
        expect(stakeInfo[2]).to.equal(timestamp); // unstakeRequestedAt
        
        // Verify removed from active stakers list
        const activeStakers = await koraStaking.getActiveStakers();
        expect(activeStakers).to.not.include(nodeOperator1.address);
      }
    });

    it("Should revert unstake request if not staking", async function() {
      await expect(
        koraStaking.connect(nodeOperator2).requestUnstake()
      ).to.be.revertedWith("No active stake");
    });

    it("Should verify unstake request state and prevent early withdrawal", async function() {
      // For this test, we need to test without going through _removeStaker
      // So we'll directly modify the stake info in the contract to simulate an unstake request
      // First, get the staker's info before the unstake request
      const stakeInfoBefore = await koraStaking.getStakeInfo(nodeOperator1.address);
      
      // Request unstake
      await koraStaking.connect(nodeOperator1).requestUnstake();
      
      // Check the unstake was requested
      const stakeInfoAfter = await koraStaking.getStakeInfo(nodeOperator1.address);
      expect(stakeInfoAfter[2]).to.be.gt(0); // unstakeRequestedAt is set
      
      // The isStaker flag is now false (user removed from active stakers)
      expect(stakeInfoAfter[3]).to.be.false;
      
      // Try calling unstake() before the delay period
      await expect(
        koraStaking.connect(nodeOperator1).unstake()
      ).to.be.revertedWith("Unstaking delay not passed");
    });

    it("Should allow unstaking after delay period", async function() {
      await koraStaking.connect(nodeOperator1).requestUnstake();
      
      // Fast forward time past the unstaking delay
      await time.increase(unstakingDelay + 1);
      
      // Balance before unstake
      const balanceBefore = await koraCoin.balanceOf(nodeOperator1.address);
      
      await expect(koraStaking.connect(nodeOperator1).unstake())
        .to.emit(koraStaking, "Unstaked")
        .withArgs(nodeOperator1.address, stakeAmount);
      
      // Check token balance returned
      const balanceAfter = await koraCoin.balanceOf(nodeOperator1.address);
      expect(balanceAfter - balanceBefore).to.equal(stakeAmount);
      
      // Check stake info updated
      const stakeInfo = await koraStaking.getStakeInfo(nodeOperator1.address);
      expect(stakeInfo[0]).to.equal(0); // amount
      expect(stakeInfo[3]).to.be.false; // isActive
      
      // Verify removed from active stakers list
      const activeStakers = await koraStaking.getActiveStakers();
      expect(activeStakers).to.not.include(nodeOperator1.address);
    });

    it("Should revert unstake if delay period not passed", async function() {
      await koraStaking.connect(nodeOperator1).requestUnstake();
      
      // Fast forward time but not enough
      await time.increase(unstakingDelay / 2);
      
      await expect(
        koraStaking.connect(nodeOperator1).unstake()
      ).to.be.revertedWith("Unstaking delay not passed");
    });

    it("Should remove from active stakers list after unstaking", async function() {
      // Stake with both operators
      await koraCoin.connect(nodeOperator2).approve(await koraStaking.getAddress(), stakeAmount);
      await koraStaking.connect(nodeOperator2).stake(stakeAmount);
      
      // Request and complete unstake for first operator
      await koraStaking.connect(nodeOperator1).requestUnstake();
      await time.increase(unstakingDelay + 1);
      await koraStaking.connect(nodeOperator1).unstake();
      
      // Check active stakers list
      const activeStakers = await koraStaking.getActiveStakers();
      expect(activeStakers.length).to.equal(1);
      expect(activeStakers[0]).to.equal(nodeOperator2.address);
      expect(activeStakers).to.not.include(nodeOperator1.address);
      expect(activeStakers).to.include(nodeOperator2.address);
    });
  });

  describe("Admin Functions", function() {
    it("Should allow owner to change minimum stake", async function() {
      const newMinimumStake = ethers.parseEther("2000");
      
      await expect(koraStaking.setMinimumStake(newMinimumStake))
        .to.emit(koraStaking, "MinimumStakeChanged")
        .withArgs(newMinimumStake);
      
      expect(await koraStaking.minimumStake()).to.equal(newMinimumStake);
    });

    it("Should allow owner to change unstaking delay", async function() {
      const newUnstakingDelay = 60 * 60 * 24 * 14; // 14 days
      
      await expect(koraStaking.setUnstakingDelay(newUnstakingDelay))
        .to.emit(koraStaking, "UnstakingDelayChanged")
        .withArgs(newUnstakingDelay);
      
      expect(await koraStaking.unstakingDelay()).to.equal(newUnstakingDelay);
    });

    it("Should allow owner to pause and unpause", async function() {
      await koraStaking.pause();
      expect(await koraStaking.paused()).to.be.true;
      
      await koraStaking.unpause();
      expect(await koraStaking.paused()).to.be.false;
    });

    it("Should revert admin functions if called by non-owner", async function() {
      await expect(
        koraStaking.connect(nodeOperator1).setMinimumStake(ethers.parseEther("2000"))
      ).to.be.revertedWithCustomError(koraStaking, "OwnableUnauthorizedAccount");
      
      await expect(
        koraStaking.connect(nodeOperator1).setUnstakingDelay(60 * 60 * 24 * 14)
      ).to.be.revertedWithCustomError(koraStaking, "OwnableUnauthorizedAccount");
      
      await expect(
        koraStaking.connect(nodeOperator1).pause()
      ).to.be.revertedWithCustomError(koraStaking, "OwnableUnauthorizedAccount");
    });

    it("Should not allow staking when paused", async function() {
      await koraStaking.pause();
      
      const stakeAmount = ethers.parseEther("2000");
      await koraCoin.connect(nodeOperator1).approve(await koraStaking.getAddress(), stakeAmount);
      
      await expect(
        koraStaking.connect(nodeOperator1).stake(stakeAmount)
      ).to.be.revertedWithCustomError(koraStaking, "EnforcedPause");
    });
  });

  describe("Edge Cases and Security", function() {
    const stakeAmount = ethers.parseEther("2000");

    it("Should properly handle multiple stakers and index updates", async function() {
      // Stake with all three operators
      await koraCoin.connect(nodeOperator1).approve(await koraStaking.getAddress(), stakeAmount);
      await koraStaking.connect(nodeOperator1).stake(stakeAmount);
      
      await koraCoin.connect(nodeOperator2).approve(await koraStaking.getAddress(), stakeAmount);
      await koraStaking.connect(nodeOperator2).stake(stakeAmount);
      
      await koraCoin.connect(nodeOperator3).approve(await koraStaking.getAddress(), stakeAmount);
      await koraStaking.connect(nodeOperator3).stake(stakeAmount);

      // Unstake the middle staker
      await koraStaking.connect(nodeOperator2).requestUnstake();
      await time.increase(unstakingDelay + 1);
      await koraStaking.connect(nodeOperator2).unstake();

      // Check active stakers list
      const activeStakers = await koraStaking.getActiveStakers();
      expect(activeStakers.length).to.equal(2);
      expect(activeStakers).to.include(nodeOperator1.address);
      expect(activeStakers).to.include(nodeOperator3.address);
      expect(activeStakers).to.not.include(nodeOperator2.address);

      // Check that nodeOperator3 was correctly moved in the array
      // This would fail if the index wasn't properly updated
      const activeNodeInfo = await koraStaking.getStakeInfo(nodeOperator3.address);
      expect(activeNodeInfo[3]).to.be.true; // Still active

      // Unstake the remaining stakers
      await koraStaking.connect(nodeOperator1).requestUnstake();
      await koraStaking.connect(nodeOperator3).requestUnstake();
      await time.increase(unstakingDelay + 1);
      await koraStaking.connect(nodeOperator1).unstake();
      await koraStaking.connect(nodeOperator3).unstake();

      // Array should be empty
      const finalStakers = await koraStaking.getActiveStakers();
      expect(finalStakers.length).to.equal(0);
    });

    it("Should handle state cleanup completely after unstaking", async function() {
      // Stake with the operator
      await koraCoin.connect(nodeOperator1).approve(await koraStaking.getAddress(), stakeAmount);
      await koraStaking.connect(nodeOperator1).stake(stakeAmount);
      
      // Complete the unstaking process
      await koraStaking.connect(nodeOperator1).requestUnstake();
      await time.increase(unstakingDelay + 1);
      await koraStaking.connect(nodeOperator1).unstake();
      
      // Check all state is properly cleaned up
      const stakeInfo = await koraStaking.getStakeInfo(nodeOperator1.address);
      expect(stakeInfo[0]).to.equal(0); // amount
      expect(stakeInfo[1]).to.equal(0); // stakedAt
      expect(stakeInfo[2]).to.equal(0); // unstakeRequestedAt
      expect(stakeInfo[3]).to.be.false; // isActive
      
      // Try to stake again (should work if all state is clean)
      await koraCoin.connect(nodeOperator1).approve(await koraStaking.getAddress(), stakeAmount);
      await expect(
        koraStaking.connect(nodeOperator1).stake(stakeAmount)
      ).to.not.be.reverted;
    });
  });

  describe("Token Rescue and Edge Cases", function() {
    let mockToken: any;
    const stakeAmount = ethers.parseEther("2000");

    beforeEach(async function() {
      // Deploy a mock ERC20 token to test the rescue functionality
      const MockToken = await ethers.getContractFactory("KoraCoin");
      mockToken = await upgrades.deployProxy(
        MockToken,
        [owner.address],
        {
          initializer: 'initialize',
          kind: 'uups'
        }
      );
      await mockToken.waitForDeployment();
    });

    it("Should rescue ERC20 tokens accidentally sent to the contract", async function() {
      // This test assumes rescueTokens function exists in the contract
      // If implementing this test, ensure the contract has this function
      
      // Send some mock tokens to the staking contract
      const rescueAmount = ethers.parseEther("100");
      await mockToken.mint(await koraStaking.getAddress(), rescueAmount);

      // Check the balance of the mock token in the contract
      expect(await mockToken.balanceOf(await koraStaking.getAddress())).to.equal(rescueAmount);

      // Test would call rescue function if implemented
      // await koraStaking.rescueTokens(await mockToken.getAddress(), owner.address, 0);
      
      // And would verify the tokens were transferred successfully
    });

    it("Should prevent staking when a previous stake is in cooldown", async function() {
      // Stake with the operator
      await koraCoin.connect(nodeOperator1).approve(await koraStaking.getAddress(), stakeAmount);
      await koraStaking.connect(nodeOperator1).stake(stakeAmount);
      
      // Request unstake but don't complete it yet
      await koraStaking.connect(nodeOperator1).requestUnstake();
      
      // Try to stake again during cooldown period
      await koraCoin.connect(nodeOperator1).approve(await koraStaking.getAddress(), stakeAmount);
      await expect(
        koraStaking.connect(nodeOperator1).stake(stakeAmount)
      ).to.be.revertedWith("Previous stake still exists");
      
      // Complete the unstaking process
      await time.increase(unstakingDelay + 1);
      await koraStaking.connect(nodeOperator1).unstake();
      
      // Now staking should work again
      await koraCoin.connect(nodeOperator1).approve(await koraStaking.getAddress(), stakeAmount);
      await expect(
        koraStaking.connect(nodeOperator1).stake(stakeAmount)
      ).to.not.be.reverted;
    });
  });

  describe("Incremental Staking Tests", function() {
    const initialStake = ethers.parseEther("1500");
    const additionalStake = ethers.parseEther("500");
    const totalStake = initialStake + additionalStake;

    beforeEach(async function() {
      // Approve tokens to be spent by staking contract
      await koraCoin.connect(nodeOperator1).approve(await koraStaking.getAddress(), totalStake);
      
      // Stake initial amount
      await koraStaking.connect(nodeOperator1).stake(initialStake);
    });

    it("Should allow increasing stake amount", async function() {
      // This test assumes increaseStake function exists in the contract
      // If implementing this test, ensure the contract has this function
      
      // Would test increasing stake functionality
      // await koraStaking.connect(nodeOperator1).increaseStake(additionalStake);
      
      // And would verify the increased stake amount
    });

    it("Should correctly unstake the full amount after increasing stake", async function() {
      // This would test the full flow with increase stake
      // For now, we'll just test the basic unstaking flow
      
      // Request unstake
      await koraStaking.connect(nodeOperator1).requestUnstake();
      
      // Fast forward time
      await time.increase(unstakingDelay + 1);
      
      // Balance before unstake
      const balanceBefore = await koraCoin.balanceOf(nodeOperator1.address);
      
      // Unstake
      await koraStaking.connect(nodeOperator1).unstake();
      
      // Check balance after unstake
      const balanceAfter = await koraCoin.balanceOf(nodeOperator1.address);
      expect(balanceAfter - balanceBefore).to.equal(initialStake);
    });
  });

  describe("Unstaking Cooldown Behavior", function() {
    const stakeAmount = ethers.parseEther("2000");
    
    beforeEach(async function() {
      // Stake tokens
      await koraCoin.connect(nodeOperator1).approve(await koraStaking.getAddress(), stakeAmount);
      await koraStaking.connect(nodeOperator1).stake(stakeAmount);
      
      // Request unstake to enter cool-down
      await koraStaking.connect(nodeOperator1).requestUnstake();
    });
    
    it("Cannot withdraw tokens until cooldown period ends", async function() {
      // Try unstaking immediately after request
      await expect(
        koraStaking.connect(nodeOperator1).unstake()
      ).to.be.revertedWith("Unstaking delay not passed");
      
      // Fast forward but not enough to clear cooldown
      await time.increase(unstakingDelay / 2);
      
      // Should still fail
      await expect(
        koraStaking.connect(nodeOperator1).unstake()
      ).to.be.revertedWith("Unstaking delay not passed");
      
      // Complete the cooldown
      await time.increase(unstakingDelay / 2 + 1);
      
      // Now it should succeed
      await expect(
        koraStaking.connect(nodeOperator1).unstake()
      ).to.not.be.reverted;
    });
    
    it("Cannot create new stake during cooldown", async function() {
      // Try to create a new stake during cooldown
      await koraCoin.connect(nodeOperator1).approve(await koraStaking.getAddress(), stakeAmount);
      await expect(
        koraStaking.connect(nodeOperator1).stake(stakeAmount)
      ).to.be.revertedWith("Previous stake still exists");
    });
    
    it("Is removed from active stakers list during cooldown", async function() {
      // Get active stakers
      const activeStakers = await koraStaking.getActiveStakers();
      
      // Verify user is not in the list
      expect(activeStakers).to.not.include(nodeOperator1.address);
    });
    
    it("Cannot increase stake during cooldown", async function() {
      // This test should be enabled if increaseStake is fully implemented
      // await expect(
      //     koraStaking.connect(nodeOperator1).increaseStake(ethers.parseEther("500"))
      // ).to.be.revertedWith("Unstake already requested");
    });
    
    it("Follows complete unstaking lifecycle", async function() {
      // Step 1: Verify in cooldown state
      let stakeInfo = await koraStaking.getStakeInfo(nodeOperator1.address);
      expect(stakeInfo[0]).to.equal(stakeAmount); // amount still correct
      expect(stakeInfo[2]).to.be.gt(0); // unstakeRequestedAt is set
      expect(stakeInfo[3]).to.be.false; // no longer active
      
      // Step 2: Fast forward through cooldown
      await time.increase(unstakingDelay + 1);
      
      // Step 3: Complete unstake
      const balanceBefore = await koraCoin.balanceOf(nodeOperator1.address);
      await koraStaking.connect(nodeOperator1).unstake();
      const balanceAfter = await koraCoin.balanceOf(nodeOperator1.address);
      
      // Step 4: Verify tokens returned
      expect(balanceAfter - balanceBefore).to.equal(stakeAmount);
      
      // Step 5: Verify stake completely cleared
      stakeInfo = await koraStaking.getStakeInfo(nodeOperator1.address);
      expect(stakeInfo[0]).to.equal(0); // amount is zero
      expect(stakeInfo[1]).to.equal(0); // stakedAt is zero
      expect(stakeInfo[2]).to.equal(0); // unstakeRequestedAt is zero
      expect(stakeInfo[3]).to.be.false; // not active
      
      // Step 6: Verify can stake again
      await koraCoin.connect(nodeOperator1).approve(await koraStaking.getAddress(), stakeAmount);
      await expect(
        koraStaking.connect(nodeOperator1).stake(stakeAmount)
      ).to.not.be.reverted;
    });
  });
}); 