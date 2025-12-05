pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract CreditScoreFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    address public owner;
    mapping(address => bool) public isProvider;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;
    uint256 public cooldownSeconds = 60;
    bool public paused = false;
    uint256 public currentBatchId = 0;
    bool public batchOpen = false;

    struct EncryptedUserData {
        euint32 transactionCount;
        euint32 averageTransactionValue;
        euint32 didScore;
    }
    mapping(address => EncryptedUserData) public userEncryptedData;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event CooldownSecondsUpdated(uint256 oldCooldown, uint256 newCooldown);
    event ContractPaused(address indexed account);
    event ContractUnpaused(address indexed account);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event UserDataSubmitted(address indexed user, uint256 indexed batchId);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId, bytes32 stateHash);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint256 score);

    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error BatchNotOpen();
    error ReplayAttempt();
    error StateMismatch();
    error InvalidProof();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier checkSubmissionCooldown(address _user) {
        if (block.timestamp < lastSubmissionTime[_user] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    modifier checkDecryptionCooldown() {
        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function addProvider(address provider) external onlyOwner {
        isProvider[provider] = true;
        emit ProviderAdded(provider);
    }

    function removeProvider(address provider) external onlyOwner {
        isProvider[provider] = false;
        emit ProviderRemoved(provider);
    }

    function setCooldownSeconds(uint256 newCooldown) external onlyOwner {
        require(newCooldown > 0, "Cooldown must be positive");
        emit CooldownSecondsUpdated(cooldownSeconds, newCooldown);
        cooldownSeconds = newCooldown;
    }

    function pause() external onlyOwner {
        paused = true;
        emit ContractPaused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit ContractUnpaused(msg.sender);
    }

    function openBatch() external onlyOwner whenNotPaused {
        currentBatchId++;
        batchOpen = true;
        emit BatchOpened(currentBatchId);
    }

    function closeBatch() external onlyOwner whenNotPaused {
        batchOpen = false;
        emit BatchClosed(currentBatchId);
    }

    function submitEncryptedUserData(
        euint32 _transactionCount,
        euint32 _averageTransactionValue,
        euint32 _didScore
    ) external onlyProvider whenNotPaused checkSubmissionCooldown(msg.sender) {
        if (!batchOpen) revert BatchNotOpen();
        if (!_transactionCount.isInitialized()) revert("TransactionCount not initialized");
        if (!_averageTransactionValue.isInitialized()) revert("AverageTransactionValue not initialized");
        if (!_didScore.isInitialized()) revert("DIDScore not initialized");

        userEncryptedData[msg.sender] = EncryptedUserData(_transactionCount, _averageTransactionValue, _didScore);
        lastSubmissionTime[msg.sender] = block.timestamp;
        emit UserDataSubmitted(msg.sender, currentBatchId);
    }

    function calculateAndRequestCreditScore(uint256 _batchId) external whenNotPaused checkDecryptionCooldown {
        if (_batchId == 0 || _batchId > currentBatchId) revert("Invalid batchId");
        if (batchOpen) revert("Batch must be closed for calculation");

        euint32 memory totalScore = FHE.asEuint32(0);
        euint32 memory userCount = FHE.asEuint32(0);

        address[] memory providers = new address[](1); // Simplified for example
        providers[0] = msg.sender; // In a real system, iterate over all providers who submitted to this batch

        for (uint256 i = 0; i < providers.length; i++) {
            EncryptedUserData memory data = userEncryptedData[providers[i]];
            if (data.transactionCount.isInitialized()) {
                // Simple scoring: (transactionCount * averageTransactionValue) + didScore
                euint32 memory transactionComponent = data.transactionCount.fheMul(data.averageTransactionValue);
                euint32 memory userScore = transactionComponent.fheAdd(data.didScore);
                totalScore = totalScore.fheAdd(userScore);
                userCount = userCount.fheAdd(FHE.asEuint32(1));
            }
        }

        euint32 memory finalScore = (userCount.isZero()).select(FHE.asEuint32(0), totalScore.fheDiv(userCount));
        bytes32[] memory cts = new bytes32[](1);
        cts[0] = finalScore.toBytes32();

        bytes32 stateHash = keccak256(abi.encode(cts, address(this)));
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);
        decryptionContexts[requestId] = DecryptionContext({ batchId: _batchId, stateHash: stateHash, processed: false });
        lastDecryptionRequestTime[msg.sender] = block.timestamp;
        emit DecryptionRequested(requestId, _batchId, stateHash);
    }

    function myCallback(uint256 requestId, bytes memory cleartexts, bytes memory proof) public {
        if (decryptionContexts[requestId].processed) revert ReplayAttempt();

        // Rebuild cts in the exact same order as in calculateAndRequestCreditScore
        // For this example, it's a single score
        euint32 memory finalScore = FHE.asEuint32(0); // Placeholder to get .toBytes32()
        bytes32[] memory cts = new bytes32[](1);
        cts[0] = finalScore.toBytes32(); // This will be the ciphertext from storage

        bytes32 currentHash = keccak256(abi.encode(cts, address(this)));
        if (currentHash != decryptionContexts[requestId].stateHash) revert StateMismatch();

        if (!FHE.checkSignatures(requestId, cleartexts, proof)) revert InvalidProof();

        uint256 score = abi.decode(cleartexts, (uint256));
        decryptionContexts[requestId].processed = true;
        emit DecryptionCompleted(requestId, decryptionContexts[requestId].batchId, score);
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 s) internal pure returns (euint32) {
        return s.isInitialized() ? s : FHE.asEuint32(0);
    }

    function _requireInitialized(euint32 s) internal pure {
        if (!s.isInitialized()) revert("Ciphertext not initialized");
    }
}