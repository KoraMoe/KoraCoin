import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { Contract, ContractFactory } from "ethers";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { KoraCoin } from "../typechain-types";

describe("KoraCoin", function() {
  let KoraCoin: ContractFactory;
  let koraCoin: KoraCoin;
  let owner: SignerWithAddress;
  let addr1: SignerWithAddress;
  let addr2: SignerWithAddress;

  beforeEach(async function() {
    // Get the ContractFactory and Signers here
    KoraCoin = await ethers.getContractFactory("KoraCoin");
    [owner, addr1, addr2] = await ethers.getSigners();

    // Deploy proxy with owner as initialOwner
    koraCoin = await upgrades.deployProxy(KoraCoin, [owner.address], {
      initializer: 'initialize',
      kind: 'uups',
    }) as KoraCoin;
  });

  describe("Deployment", function() {
    it("Should set the right owner", async function() {
      expect(await koraCoin.owner()).to.equal(owner.address);
    });

    it("Should have correct name and symbol", async function() {
      expect(await koraCoin.name()).to.equal("KoraCoin");
      expect(await koraCoin.symbol()).to.equal("KORA");
    });

    it("Should start with zero total supply", async function() {
      expect(await koraCoin.totalSupply()).to.equal(0);
    });
  });

  describe("Minting", function() {
    it("Should allow owner to mint tokens", async function() {
      const mintAmount = ethers.parseEther("100");
      await koraCoin.mint(addr1.address, mintAmount);
      
      expect(await koraCoin.balanceOf(addr1.address)).to.equal(mintAmount);
      expect(await koraCoin.totalSupply()).to.equal(mintAmount);
    });

    it("Should fail if non-owner tries to mint", async function() {
      const mintAmount = ethers.parseEther("100");
      await expect(
        koraCoin.connect(addr1).mint(addr2.address, mintAmount)
      ).to.be.revertedWithCustomError(koraCoin, "OwnableUnauthorizedAccount");
    });
  });

  describe("Burning", function() {
    const mintAmount = ethers.parseEther("100");

    beforeEach(async function() {
      // Mint some tokens to addr1 before each test
      await koraCoin.mint(addr1.address, mintAmount);
    });

    it("Should allow token holders to burn their tokens", async function() {
      const burnAmount = ethers.parseEther("50");
      await koraCoin.connect(addr1).burn(burnAmount);

      expect(await koraCoin.balanceOf(addr1.address)).to.equal(mintAmount - burnAmount);
      expect(await koraCoin.totalSupply()).to.equal(mintAmount - burnAmount);
    });

    it("Should fail if trying to burn more than balance", async function() {
      const burnAmount = ethers.parseEther("150"); // More than minted
      await expect(
        koraCoin.connect(addr1).burn(burnAmount)
      ).to.be.revertedWithCustomError(koraCoin, "ERC20InsufficientBalance");
    });
  });

  describe("Upgradeability", function() {
    it("Should allow owner to upgrade the implementation", async function() {
      // Deploy new implementation
      const KoraCoinV2 = await ethers.getContractFactory("KoraCoin");
      const upgraded = await upgrades.upgradeProxy(await koraCoin.getAddress(), KoraCoinV2) as KoraCoin;

      // Verify upgrade was successful
      expect(await upgraded.owner()).to.equal(owner.address);
      expect(await upgraded.name()).to.equal("KoraCoin");
      expect(await upgraded.symbol()).to.equal("KORA");
    });

    it("Should fail if non-owner tries to upgrade", async function() {
      const KoraCoinV2 = await ethers.getContractFactory("KoraCoin");
      await expect(
        upgrades.upgradeProxy(await koraCoin.getAddress(), KoraCoinV2.connect(addr1))
      ).to.be.revertedWithCustomError(koraCoin, "OwnableUnauthorizedAccount");
    });
  });

  describe("Transfers", function() {
    const mintAmount = ethers.parseEther("100");

    beforeEach(async function() {
      await koraCoin.mint(addr1.address, mintAmount);
    });

    it("Should transfer tokens between accounts", async function() {
      const transferAmount = ethers.parseEther("50");
      await koraCoin.connect(addr1).transfer(addr2.address, transferAmount);

      expect(await koraCoin.balanceOf(addr1.address)).to.equal(mintAmount - transferAmount);
      expect(await koraCoin.balanceOf(addr2.address)).to.equal(transferAmount);
    });

    it("Should fail if sender doesn't have enough tokens", async function() {
      const transferAmount = ethers.parseEther("150"); // More than balance
      await expect(
        koraCoin.connect(addr1).transfer(addr2.address, transferAmount)
      ).to.be.revertedWithCustomError(koraCoin, "ERC20InsufficientBalance");
    });
  });
}); 