// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20BurnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

/**
 * @title KoraCoin
 * @dev Implementation of the KoraCoin
 * This token is controlled by a multisig wallet which can upgrade the contract.
 */
contract KoraCoin is
    Initializable,
    ERC20Upgradeable,
    ERC20BurnableUpgradeable,
    OwnableUpgradeable,
    UUPSUpgradeable
{
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @dev Initialize the KoraCoin contract
     * @param initialOwner The address that will be the initial owner of the contract
     */
    function initialize(address initialOwner) public initializer {
        __ERC20_init("KoraCoin", "KORA");
        __ERC20Burnable_init();
        __Ownable_init(initialOwner);
        __UUPSUpgradeable_init();
    }

    /**
     * @dev Function to mint tokens
     * @param to The address that will receive the minted tokens
     * @param amount The amount of tokens to mint
     * Only the owner (multisig) can call this function
     */
    function mint(address to, uint256 amount) public virtual onlyOwner {
        _mint(to, amount);
    }

    /**
     * @dev Function that authorizes an upgrade to a new implementation
     * @param newImplementation Address of the new implementation
     * Only the owner (multisig) can authorize upgrades
     */
    function _authorizeUpgrade(
        address newImplementation
    ) internal override onlyOwner {}
}
