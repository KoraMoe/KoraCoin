import { ethers, upgrades } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`Deployer address: ${deployer.address}`);

  // In production, this should be the Safe multisig address
  const safeMultisigAddress = deployer.address;
  console.log(`Safe multisig address (for ownership): ${safeMultisigAddress}`);

  // Get the KoraCoin token address - this should be the actual deployed proxy address
  // For this example, we'll deploy a new KoraCoin token
  console.log("Deploying KoraCoin token...");
  const KoraCoin = await ethers.getContractFactory("KoraCoin");
  const koraCoin = await upgrades.deployProxy(
    KoraCoin,
    [safeMultisigAddress],
    {
      initializer: 'initialize',
      kind: 'uups'
    }
  );
  await koraCoin.waitForDeployment();
  const koraCoinAddress = await koraCoin.getAddress();
  console.log(`KoraCoin deployed to: ${koraCoinAddress}`);

  // Configure staking parameters with optimized uint types
  const minimumStake = BigInt(ethers.parseEther("1000")); // 1000 KORA minimum stake
  const unstakingDelay = BigInt(60 * 60 * 24 * 7); // 7 days in seconds (as a uint64)

  // Deploy the KoraStaking contract
  console.log("Deploying KoraStaking contract...");
  const KoraStaking = await ethers.getContractFactory("KoraStaking");
  const koraStaking = await upgrades.deployProxy(
    KoraStaking,
    [
      koraCoinAddress,
      minimumStake,       // uint128
      unstakingDelay,     // uint64
      safeMultisigAddress
    ],
    {
      initializer: 'initialize',
      kind: 'uups'
    }
  );

  await koraStaking.waitForDeployment();
  const stakingAddress = await koraStaking.getAddress();
  console.log(`KoraStaking deployed to: ${stakingAddress}`);

  console.log("\n--- Configuration Summary ---");
  console.log(`KoraCoin Token: ${koraCoinAddress}`);
  console.log(`KoraStaking: ${stakingAddress}`);
  console.log(`Minimum Stake: ${ethers.formatEther(minimumStake)} KORA`);
  console.log(`Unstaking Delay: ${Number(unstakingDelay) / (60 * 60 * 24)} days`);
  console.log(`Owner (Safe Multisig): ${safeMultisigAddress}`);
  console.log("\nNext steps:");
  console.log("1. Mint KoraCoin tokens to distribute to node operators");
  console.log("2. Node operators need to approve KoraStaking contract to spend their tokens");
  console.log("3. Node operators can call stake() with their desired amount");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
