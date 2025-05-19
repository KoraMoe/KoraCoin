// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title KoraStaking
 * @dev Implementation of a staking contract for KoraCoin
 * Allows nodes to stake tokens and participate in the network
 */
contract KoraStaking is
    Initializable,
    OwnableUpgradeable,
    UUPSUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable
{
    using SafeERC20 for IERC20;

    // Structure to store staking information (efficiently packed into 2 storage slots)
    struct StakeInfo {
        uint128 amount;           // Amount staked (16 bytes)
        uint64 stakedAt;          // When the stake was created (8 bytes)
        uint64 unstakeRequestedAt;// When unstake was requested (8 bytes)
        uint32 arrayIndex;        // Index in the stakers array for O(1) removal (4 bytes)
        uint256 pubCommitment;    // VRF public commitment
    }
    
    // Immutable and constant variables
    IERC20 public koraToken;
    uint128 public minimumStake;
    uint64 public unstakingDelay;
    
    // Staking data
    mapping(address => StakeInfo) public stakes;
    address[] private stakers;
    mapping(address => bool) public isStaker;
    
    // New optimization variables
    uint256 public totalStakedAmount;  // Total amount staked by all validators
    
    // Maximum number of stakers (uint32 max)
    uint256 private constant MAX_STAKERS = 2000000;

    // Reserve space for future upgrades
    uint256[100] private __gap;
    
    // Events
    event Staked(address indexed staker, uint128 amount, uint256 pubCommitment);
    event UnstakeRequested(address indexed staker, uint64 requestedAt);
    event Unstaked(address indexed staker, uint128 amount);
    event MinimumStakeChanged(uint128 newMinimumStake);
    event UnstakingDelayChanged(uint64 newUnstakingDelay);
    event StakeIncreased(address indexed staker, uint128 additionalAmount, uint128 newTotal);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @dev Initialize the KoraStaking contract
     * @param _koraToken Address of the KoraCoin token
     * @param _minimumStake Minimum amount of tokens to stake
     * @param _unstakingDelay Time delay in seconds before unstaking is allowed
     * @param initialOwner The address that will be the initial owner of the contract
     */
    function initialize(
        address _koraToken,
        uint128 _minimumStake,
        uint64 _unstakingDelay,
        address initialOwner
    ) external initializer {
        __Ownable_init(initialOwner);
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        require(_koraToken.code.length > 0, "KoraToken must be a contract");
        require(_minimumStake > 0, "Minimum stake must be greater than 0");
        require(_unstakingDelay > 0, "Unstaking delay must be greater than 0");

        koraToken = IERC20(_koraToken);
        minimumStake = _minimumStake;
        unstakingDelay = _unstakingDelay;
        totalStakedAmount = 0;
    }

    /**
     * @dev Stake tokens
     * @param amount Amount of tokens to stake
     * @param pubCommitment VRF public commitment (PUB)
     */
    function stake(uint128 amount, uint256 pubCommitment) external nonReentrant whenNotPaused {
        require(amount >= minimumStake, "Amount below minimum stake");
        require(!isStaker[msg.sender], "Already staking");
        require(stakes[msg.sender].amount == 0, "Previous stake still exists");
        require(stakers.length < MAX_STAKERS, "Max stakers limit reached");
        require(pubCommitment != 0, "Public commitment cannot be zero");
        
        // Transfer tokens from sender to this contract
        koraToken.safeTransferFrom(msg.sender, address(this), amount);
        
        // Record stake - use memory to calculate everything before updating storage
        uint64 currentTime = uint64(block.timestamp);
        
        // Add to stakers list and track the index
        uint32 newIndex = uint32(stakers.length);
        stakers.push(msg.sender);
        
        // Update storage once with complete StakeInfo
        stakes[msg.sender] = StakeInfo({
            amount: amount,
            stakedAt: currentTime,
            unstakeRequestedAt: 0,
            arrayIndex: newIndex,
            pubCommitment: pubCommitment
        });
        
        isStaker[msg.sender] = true;
        
        // Update total staked amount
        totalStakedAmount += amount;
        
        emit Staked(msg.sender, amount, pubCommitment);
    }

    /**
     * @dev Increase the amount of tokens staked
     * @param additionalAmount Amount of additional tokens to stake
     */
    function increaseStake(uint128 additionalAmount) external nonReentrant whenNotPaused {
        require(additionalAmount > 0, "Amount must be greater than 0");
        require(isStaker[msg.sender], "No active stake");
        require(stakes[msg.sender].unstakeRequestedAt == 0, "Unstake already requested");
        
        StakeInfo storage stakeInfo = stakes[msg.sender];
        
        // Transfer the additional tokens to the contract
        koraToken.safeTransferFrom(msg.sender, address(this), additionalAmount);
        
        // Update stake amount
        stakeInfo.amount += additionalAmount;
        
        // Update total staked amount
        totalStakedAmount += additionalAmount;
        
        emit StakeIncreased(msg.sender, additionalAmount, stakeInfo.amount);
    }

    /**
     * @dev Request to unstake tokens
     * Starts the unstaking delay period
     */
    function requestUnstake() external nonReentrant whenNotPaused {
        require(isStaker[msg.sender], "No active stake");
        StakeInfo storage stakeInfo = stakes[msg.sender];
        require(stakeInfo.unstakeRequestedAt == 0, "Unstake already requested");
        
        uint64 currentTime = uint64(block.timestamp);
        stakeInfo.unstakeRequestedAt = currentTime;

        uint32 indexToRemove = stakeInfo.arrayIndex;
        
        // Validate index before removing (prevents potential exploits)
        require(indexToRemove < stakers.length, "Invalid index");
        require(stakers[indexToRemove] == msg.sender, "Index mismatch");
        
        // Remove from stakers list using O(1) swap and pop
        _removeStaker(msg.sender, indexToRemove);
        
        // Update total staked amount (but leave the actual tokens until unstake is complete)
        totalStakedAmount -= stakeInfo.amount;
        
        emit UnstakeRequested(msg.sender, currentTime);
    }

    /**
     * @dev Complete unstaking after delay period
     */
    function unstake() external nonReentrant whenNotPaused {
        require(stakes[msg.sender].amount > 0, "No active stake");
        StakeInfo storage stakeInfo = stakes[msg.sender];
        require(stakeInfo.unstakeRequestedAt > 0, "Unstake not requested");
        require(
            block.timestamp >= stakeInfo.unstakeRequestedAt + unstakingDelay,
            "Unstaking delay not passed"
        );
        
        uint128 amountToUnstake = stakeInfo.amount;
        // Transfer tokens back to staker
        koraToken.safeTransfer(msg.sender, amountToUnstake);

        // Delete the stake info entry completely to save storage space
        delete stakes[msg.sender];
        
        emit Unstaked(msg.sender, amountToUnstake);
    }

    /**
     * @dev Slash a portion of a validator's stake
     * @param validator The address of the validator to slash
     * @param slashPercentage The percentage to slash (in basis points, e.g. 1000 = 10%)
     * @return The amount slashed
     * @notice Only callable by approved consensus contracts
     */
    function slashValidator(address validator, uint256 slashPercentage) external whenNotPaused returns (uint256) {
        // TODO: Add access control - only approved consensus contracts
        require(isStaker[validator], "Not an active staker");
        require(slashPercentage > 0 && slashPercentage <= 10000, "Invalid slash percentage");
        
        StakeInfo storage stakeInfo = stakes[validator];
        require(stakeInfo.amount > 0, "No stake to slash");
        
        // Calculate slash amount
        uint256 slashAmount = (uint256(stakeInfo.amount) * slashPercentage) / 10000;
        uint128 remainingAmount = stakeInfo.amount - uint128(slashAmount);
        
        // Update stake amount
        stakeInfo.amount = remainingAmount;
        
        // Update total staked amount
        totalStakedAmount -= uint128(slashAmount);
        
        // Return slashed amount - the contract calling this can decide what to do with it
        return slashAmount;
    }

    /**
     * @dev Remove staker from the stakers array with O(1) time complexity
     * @param staker The address to remove
     * @param index The index of the staker in the array
     */
    function _removeStaker(address staker, uint32 index) private {
        // Mark as no longer staking
        delete isStaker[staker];
        
        // Only swap if not the last element
        uint256 lastIndex = stakers.length - 1;
        if (index != lastIndex) {
            // Get the last staker address
            address lastStaker = stakers[lastIndex];
            
            // Move last staker to the removed position
            stakers[index] = lastStaker;
            
            // Update the moved staker's index
            stakes[lastStaker].arrayIndex = index;
        }
        
        // Remove the last element
        stakers.pop();
    }

    /**
     * @dev Get all active stakers
     * @return Array of staker addresses
     */
    function getActiveStakers() external view returns (address[] memory) {
        return stakers;
    }

    /**
     * @dev Get an active staker by index
     * @param index The index of the staker in the array
     * @return The address of the staker at the given index
     */
    function getStakerByIndex(uint256 index) external view returns (address) {
        require(index < stakers.length, "Index out of bounds");
        return stakers[index];
    }

    /**
     * @dev Get the total number of active stakers
     * @return The number of active stakers
     */
    function getTotalStakers() external view returns (uint256) {
        return stakers.length;
    }
    
    /**
     * @dev Get staking info for a node
     * @param staker Address of the staker
     * @return amount The amount of tokens staked
     * @return stakedAt The timestamp when tokens were staked
     * @return unstakeRequestedAt The timestamp when unstake was requested (0 if not requested)
     * @return isActive Whether the stake is active
     * @return pubCommitment The VRF public commitment
     */
    function getStakeInfo(address staker) external view returns (
        uint128 amount,
        uint64 stakedAt,
        uint64 unstakeRequestedAt,
        bool isActive,
        uint256 pubCommitment
    ) {
        StakeInfo storage info = stakes[staker];
        return (
            info.amount,
            info.stakedAt,
            info.unstakeRequestedAt,
            isStaker[staker],
            info.pubCommitment
        );
    }
    
    /**
     * @dev Get the public commitment of a validator
     * @param validator Address of the validator
     * @return The validator's public commitment
     */
    function getValidatorPublicCommitment(address validator) external view returns (uint256) {
        StakeInfo storage info = stakes[validator];
        require(isStaker[validator], "Not an active staker");
        require(info.pubCommitment != 0, "No public commitment found");
        return info.pubCommitment;
    }

    /**
     * @dev Select a random validator based on stake weight
     * @param randomSeed A random seed to use for selection
     * @return The selected validator address
     */
    function selectRandomValidator(uint256 randomSeed) external view returns (address) {
        require(stakers.length > 0, "No active stakers");
        require(totalStakedAmount > 0, "No active stake");
        
        // Use the seed to get a random value between 0 and totalStakedAmount
        uint256 randomValue = uint256(keccak256(abi.encodePacked(randomSeed))) % totalStakedAmount;
        
        // Select the validator based on stake weight in a single pass
        address selectedValidator;
        uint256 cumulativeStake = 0;
        
        for (uint256 i = 0; i < stakers.length; i++) {
            address staker = stakers[i];
            
            if (isStaker[staker]) {
                cumulativeStake += stakes[staker].amount;
                if (cumulativeStake > randomValue) {
                    selectedValidator = staker;
                    break;
                }
            }
        }
        
        // If somehow we reached the end without selecting (unlikely due to totalStakedAmount check)
        // then just pick the last staker as a fallback
        if (selectedValidator == address(0) && stakers.length > 0) {
            selectedValidator = stakers[stakers.length - 1];
        }
        
        return selectedValidator;
    }

    /**
     * @dev Change the minimum stake amount
     * @param _minimumStake New minimum stake amount
     */
    function setMinimumStake(uint128 _minimumStake) external onlyOwner {
        require(_minimumStake > 0, "Minimum stake must be greater than 0");
        minimumStake = _minimumStake;
        emit MinimumStakeChanged(_minimumStake);
    }

    /**
     * @dev Change the unstaking delay
     * @param _unstakingDelay New unstaking delay in seconds
     */
    function setUnstakingDelay(uint64 _unstakingDelay) external onlyOwner {
        require(_unstakingDelay > 0, "Unstaking delay must be greater than 0");
        unstakingDelay = _unstakingDelay;
        emit UnstakingDelayChanged(_unstakingDelay);
    }
    
    /**
     * @dev Pause staking functionality
     */
    function pause() external onlyOwner {
        _pause();
    }
    
    /**
     * @dev Unpause staking functionality
     */
    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @dev Function to rescue tokens or ETH accidentally sent to the contract
     * @param token Address of the token to rescue (zero address for ETH)
     * @param to Address to send the rescued tokens/ETH
     * @param amount Amount to rescue (0 for entire balance)
     */
    function rescueTokens(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        require(to != address(0), "Cannot rescue to zero address");
        
        if (token == address(0)) {
            // Rescue ETH
            uint256 ethBalance = address(this).balance;
            uint256 amountToRescue = amount == 0 ? ethBalance : amount;
            require(amountToRescue <= ethBalance, "Insufficient ETH balance");
            
            (bool success, ) = to.call{value: amountToRescue}("");
            require(success, "ETH transfer failed");
        } else {
            // Rescue ERC20 tokens
            require(token != address(koraToken), "Cannot rescue staking token");
            
            IERC20 tokenContract = IERC20(token);
            uint256 tokenBalance = tokenContract.balanceOf(address(this));
            uint256 amountToRescue = amount == 0 ? tokenBalance : amount;
            require(amountToRescue <= tokenBalance, "Insufficient token balance");
            
            tokenContract.safeTransfer(to, amountToRescue);
        }
    }

    /**
     * @dev Function that authorizes an upgrade to a new implementation
     * @param newImplementation Address of the new implementation
     */
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
} 