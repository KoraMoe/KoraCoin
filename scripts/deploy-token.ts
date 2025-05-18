import { ethers, upgrades } from "hardhat";

async function main() {
    const [deployer] = await ethers.getSigners();
    const KoraCoin = await ethers.getContractFactory("KoraCoin");
    const koraCoin = await upgrades.deployProxy(KoraCoin, [deployer.address], {
        initializer: 'initialize',
        kind: 'uups',
    });
    await koraCoin.waitForDeployment();
    console.log("KoraCoin deployed to:", await koraCoin.getAddress());
}

main();
