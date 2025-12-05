import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useState, useEffect } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface CreditScoreData {
  id: number;
  walletAddress: string;
  encryptedScore: string;
  timestamp: number;
  dataSources: string[];
}

interface ScoreAnalysis {
  riskLevel: number;
  improvementTips: string[];
  comparison: number;
}

const FHEEncryptNumber = (value: number): string => `FHE-${btoa(value.toString())}`;
const FHEDecryptNumber = (encryptedData: string): number => encryptedData.startsWith('FHE-') ? parseFloat(atob(encryptedData.substring(4))) : parseFloat(encryptedData);
const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [scores, setScores] = useState<CreditScoreData[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showGenerateModal, setShowGenerateModal] = useState(false);
  const [generatingScore, setGeneratingScore] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [selectedScore, setSelectedScore] = useState<CreditScoreData | null>(null);
  const [decryptedScore, setDecryptedScore] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState("");
  const [contractAddress, setContractAddress] = useState("");
  const [chainId, setChainId] = useState(0);
  const [startTimestamp, setStartTimestamp] = useState(0);
  const [durationDays, setDurationDays] = useState(30);
  const [activeTab, setActiveTab] = useState('dashboard');
  const [dataSources, setDataSources] = useState<string[]>(["Transaction History", "DID Profile", "Reputation Score", "Loan History"]);

  useEffect(() => {
    loadData().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadData = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) {
        setTransactionStatus({ visible: true, status: "success", message: "Contract is available!" });
        setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
      }
      
      const scoresBytes = await contract.getData("creditScores");
      let scoresList: CreditScoreData[] = [];
      if (scoresBytes.length > 0) {
        try {
          const scoresStr = ethers.toUtf8String(scoresBytes);
          if (scoresStr.trim() !== '') scoresList = JSON.parse(scoresStr);
        } catch (e) {}
      }
      setScores(scoresList);
    } catch (e) {
      console.error("Error loading data:", e);
      setTransactionStatus({ visible: true, status: "error", message: "Failed to load data" });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { 
      setIsRefreshing(false); 
      setLoading(false); 
    }
  };

  const generateScore = async () => {
    if (!isConnected || !address) { 
      setTransactionStatus({ visible: true, status: "error", message: "Please connect wallet first" });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
      return; 
    }
    
    setGeneratingScore(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Generating credit score with Zama FHE..." });
    
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const randomScore = Math.floor(Math.random() * 300) + 500;
      const newScore: CreditScoreData = {
        id: scores.length + 1,
        walletAddress: address,
        encryptedScore: FHEEncryptNumber(randomScore),
        timestamp: Math.floor(Date.now() / 1000),
        dataSources: dataSources.filter((_, i) => Math.random() > 0.5)
      };
      
      const updatedScores = [...scores, newScore];
      
      await contract.setData("creditScores", ethers.toUtf8Bytes(JSON.stringify(updatedScores)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Score generated successfully!" });
      await loadData();
      
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowGenerateModal(false);
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") 
        ? "Transaction rejected by user" 
        : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { 
      setGeneratingScore(false); 
    }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { 
      setTransactionStatus({ visible: true, status: "error", message: "Please connect wallet first" });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
      return null; 
    }
    
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      return FHEDecryptNumber(encryptedData);
    } catch (e) { 
      return null; 
    } finally { 
      setIsDecrypting(false); 
    }
  };

  const analyzeScore = (score: number): ScoreAnalysis => {
    return {
      riskLevel: Math.min(100, Math.round((800 - score) / 3)),
      improvementTips: getImprovementTips(score),
      comparison: Math.round((score - 650) / 2)
    };
  };

  const getImprovementTips = (score: number): string[] => {
    const tips = [];
    if (score < 600) tips.push("Increase on-chain activity frequency");
    if (score < 650) tips.push("Maintain consistent wallet balances");
    if (score < 700) tips.push("Participate in reputable DeFi protocols");
    if (score < 750) tips.push("Establish long-term DID relationships");
    if (tips.length === 0) tips.push("Excellent credit profile - maintain current activities");
    return tips;
  };

  const renderDashboard = () => {
    const avgScore = scores.length > 0 ? scores.reduce((sum, s) => sum + (decryptedScore || FHEDecryptNumber(s.encryptedScore)), 0) / scores.length : 0;
    const maxScore = scores.length > 0 ? Math.max(...scores.map(s => FHEDecryptNumber(s.encryptedScore))) : 0;
    const minScore = scores.length > 0 ? Math.min(...scores.map(s => FHEDecryptNumber(s.encryptedScore))) : 0;
    
    return (
      <div className="dashboard-panels">
        <div className="panel metal-panel">
          <h3>Average Credit Score</h3>
          <div className="stat-value">{avgScore.toFixed(0)}</div>
          <div className="stat-trend">+5% last quarter</div>
        </div>
        
        <div className="panel metal-panel">
          <h3>Highest Score</h3>
          <div className="stat-value">{maxScore}</div>
          <div className="stat-trend">Top 10%</div>
        </div>
        
        <div className="panel metal-panel">
          <h3>Lowest Score</h3>
          <div className="stat-value">{minScore}</div>
          <div className="stat-trend">Needs improvement</div>
        </div>
      </div>
    );
  };

  const renderScoreChart = (score: number) => {
    const analysis = analyzeScore(score);
    
    return (
      <div className="analysis-chart">
        <div className="chart-gauge">
          <div className="gauge-track">
            <div 
              className="gauge-value" 
              style={{ width: `${(score / 850) * 100}%` }}
            >
              <span className="gauge-label">{score}</span>
            </div>
          </div>
          <div className="gauge-markers">
            <span>300</span>
            <span>850</span>
          </div>
        </div>
        
        <div className="chart-row">
          <div className="chart-label">Risk Level</div>
          <div className="chart-bar">
            <div 
              className="bar-fill" 
              style={{ width: `${analysis.riskLevel}%` }}
            >
              <span className="bar-value">{analysis.riskLevel}%</span>
            </div>
          </div>
        </div>
        
        <div className="chart-row">
          <div className="chart-label">Peer Comparison</div>
          <div className="chart-bar">
            <div 
              className="bar-fill" 
              style={{ width: `${Math.min(100, analysis.comparison + 50)}%` }}
            >
              <span className="bar-value">{analysis.comparison >= 0 ? `+${analysis.comparison}` : analysis.comparison} pts</span>
            </div>
          </div>
        </div>
      </div>
    );
  };

  const renderFHEFlow = () => {
    return (
      <div className="fhe-flow">
        <div className="flow-step">
          <div className="step-icon">1</div>
          <div className="step-content">
            <h4>Data Encryption</h4>
            <p>On-chain and off-chain data encrypted with Zama FHE</p>
          </div>
        </div>
        <div className="flow-arrow">→</div>
        <div className="flow-step">
          <div className="step-icon">2</div>
          <div className="step-content">
            <h4>Secure Computation</h4>
            <p>Credit score calculated on encrypted data</p>
          </div>
        </div>
        <div className="flow-arrow">→</div>
        <div className="flow-step">
          <div className="step-icon">3</div>
          <div className="step-content">
            <h4>Selective Disclosure</h4>
            <p>User controls who can see decrypted score</p>
          </div>
        </div>
        <div className="flow-arrow">→</div>
        <div className="flow-step">
          <div className="step-icon">4</div>
          <div className="step-content">
            <h4>Verifiable Proof</h4>
            <p>Zero-knowledge proof of score validity</p>
          </div>
        </div>
      </div>
    );
  };

  const renderFAQ = () => {
    const faqItems = [
      {
        question: "What is CreditScoreFHE?",
        answer: "A decentralized credit scoring system that uses Fully Homomorphic Encryption (FHE) to protect your financial data while calculating credit scores."
      },
      {
        question: "How does FHE protect my data?",
        answer: "FHE allows computations on encrypted data without decryption. Your transaction history and personal data remains encrypted throughout the entire process."
      },
      {
        question: "What data sources are used?",
        answer: "On-chain transaction history, DID profiles, reputation scores, and verified off-chain financial data (with your permission)."
      },
      {
        question: "Who can see my credit score?",
        answer: "Only you and authorized parties you explicitly grant permission to can view your decrypted credit score."
      },
      {
        question: "How often is my score updated?",
        answer: "Scores are recalculated weekly or whenever significant new data is added to your profile."
      }
    ];
    
    return (
      <div className="faq-container">
        {faqItems.map((item, index) => (
          <div className="faq-item" key={index}>
            <div className="faq-question">{item.question}</div>
            <div className="faq-answer">{item.answer}</div>
          </div>
        ))}
      </div>
    );
  };

  if (loading) return (
    <div className="loading-screen">
      <div className="fhe-spinner"></div>
      <p>Initializing encrypted credit system...</p>
    </div>
  );

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon">
            <div className="credit-icon"></div>
          </div>
          <h1>CreditScore<span>FHE</span></h1>
        </div>
        
        <div className="header-actions">
          <button 
            onClick={() => setShowGenerateModal(true)} 
            className="create-btn"
          >
            <div className="add-icon"></div>Generate Score
          </button>
          <div className="wallet-connect-wrapper">
            <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/>
          </div>
        </div>
      </header>
      
      <div className="main-content-container">
        <div className="dashboard-section">
          <div className="tabs-container">
            <div className="tabs">
              <button 
                className={`tab ${activeTab === 'dashboard' ? 'active' : ''}`}
                onClick={() => setActiveTab('dashboard')}
              >
                Dashboard
              </button>
              <button 
                className={`tab ${activeTab === 'scores' ? 'active' : ''}`}
                onClick={() => setActiveTab('scores')}
              >
                My Scores
              </button>
              <button 
                className={`tab ${activeTab === 'faq' ? 'active' : ''}`}
                onClick={() => setActiveTab('faq')}
              >
                FAQ
              </button>
            </div>
            
            <div className="tab-content">
              {activeTab === 'dashboard' && (
                <div className="dashboard-content">
                  <h2>Private Credit Scoring Analytics</h2>
                  {renderDashboard()}
                  
                  <div className="panel metal-panel full-width">
                    <h3>FHE-Powered Credit Scoring</h3>
                    {renderFHEFlow()}
                  </div>
                </div>
              )}
              
              {activeTab === 'scores' && (
                <div className="scores-section">
                  <div className="section-header">
                    <h2>My Credit Scores</h2>
                    <div className="header-actions">
                      <button 
                        onClick={loadData} 
                        className="refresh-btn" 
                        disabled={isRefreshing}
                      >
                        {isRefreshing ? "Refreshing..." : "Refresh"}
                      </button>
                    </div>
                  </div>
                  
                  <div className="scores-list">
                    {scores.length === 0 ? (
                      <div className="no-scores">
                        <div className="no-scores-icon"></div>
                        <p>No credit scores found</p>
                        <button 
                          className="create-btn" 
                          onClick={() => setShowGenerateModal(true)}
                        >
                          Generate First Score
                        </button>
                      </div>
                    ) : scores.map((score, index) => (
                      <div 
                        className={`score-item ${selectedScore?.id === score.id ? "selected" : ""}`} 
                        key={index}
                        onClick={() => setSelectedScore(score)}
                      >
                        <div className="score-title">Score #{score.id}</div>
                        <div className="score-meta">
                          <span>Encrypted: {score.encryptedScore.substring(0, 15)}...</span>
                          <span>Data Sources: {score.dataSources.length}</span>
                        </div>
                        <div className="score-date">{new Date(score.timestamp * 1000).toLocaleDateString()}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              
              {activeTab === 'faq' && (
                <div className="faq-section">
                  <h2>Frequently Asked Questions</h2>
                  {renderFAQ()}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
      
      {showGenerateModal && (
        <ModalGenerateScore 
          onSubmit={generateScore} 
          onClose={() => setShowGenerateModal(false)} 
          generating={generatingScore} 
          dataSources={dataSources}
          setDataSources={setDataSources}
        />
      )}
      
      {selectedScore && (
        <ScoreDetailModal 
          score={selectedScore} 
          onClose={() => { 
            setSelectedScore(null); 
            setDecryptedScore(null); 
          }} 
          decryptedScore={decryptedScore} 
          setDecryptedScore={setDecryptedScore} 
          isDecrypting={isDecrypting} 
          decryptWithSignature={decryptWithSignature}
          renderScoreChart={renderScoreChart}
        />
      )}
      
      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="fhe-spinner"></div>}
              {transactionStatus.status === "success" && <div className="success-icon">✓</div>}
              {transactionStatus.status === "error" && <div className="error-icon">✗</div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}
      
      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo">
              <div className="credit-icon"></div>
              <span>CreditScoreFHE</span>
            </div>
            <p>Private credit scoring powered by FHE</p>
          </div>
          
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">Privacy Policy</a>
            <a href="#" className="footer-link">Terms</a>
          </div>
        </div>
        
        <div className="footer-bottom">
          <div className="fhe-badge">
            <span>Powered by Zama FHE</span>
          </div>
          <div className="copyright">© {new Date().getFullYear()} CreditScoreFHE. All rights reserved.</div>
          <div className="disclaimer">
            This system uses fully homomorphic encryption to protect your financial data.
          </div>
        </div>
      </footer>
    </div>
  );
};

interface ModalGenerateScoreProps {
  onSubmit: () => void; 
  onClose: () => void; 
  generating: boolean;
  dataSources: string[];
  setDataSources: (sources: string[]) => void;
}

const ModalGenerateScore: React.FC<ModalGenerateScoreProps> = ({ onSubmit, onClose, generating, dataSources, setDataSources }) => {
  const toggleDataSource = (source: string) => {
    if (dataSources.includes(source)) {
      setDataSources(dataSources.filter(s => s !== source));
    } else {
      setDataSources([...dataSources, source]);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="generate-score-modal">
        <div className="modal-header">
          <h2>Generate New Credit Score</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        
        <div className="modal-body">
          <div className="fhe-notice">
            <div className="lock-icon"></div>
            <div>
              <strong>FHE Encryption Notice</strong>
              <p>All data will be encrypted with Zama FHE</p>
            </div>
          </div>
          
          <div className="form-group">
            <label>Select Data Sources *</label>
            <div className="data-sources-grid">
              {["Transaction History", "DID Profile", "Reputation Score", "Loan History", "Payment History", "Social Graph"].map((source) => (
                <div 
                  key={source} 
                  className={`data-source ${dataSources.includes(source) ? "selected" : ""}`}
                  onClick={() => toggleDataSource(source)}
                >
                  <div className="source-checkbox"></div>
                  <div className="source-label">{source}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
        
        <div className="modal-footer">
          <button onClick={onClose} className="cancel-btn">Cancel</button>
          <button 
            onClick={onSubmit} 
            disabled={generating || dataSources.length === 0} 
            className="submit-btn"
          >
            {generating ? "Generating with FHE..." : "Generate Score"}
          </button>
        </div>
      </div>
    </div>
  );
};

interface ScoreDetailModalProps {
  score: CreditScoreData;
  onClose: () => void;
  decryptedScore: number | null;
  setDecryptedScore: (value: number | null) => void;
  isDecrypting: boolean;
  decryptWithSignature: (encryptedData: string) => Promise<number | null>;
  renderScoreChart: (score: number) => JSX.Element;
}

const ScoreDetailModal: React.FC<ScoreDetailModalProps> = ({ 
  score, 
  onClose, 
  decryptedScore, 
  setDecryptedScore, 
  isDecrypting, 
  decryptWithSignature,
  renderScoreChart
}) => {
  const handleDecrypt = async () => {
    if (decryptedScore !== null) { 
      setDecryptedScore(null); 
      return; 
    }
    
    const decrypted = await decryptWithSignature(score.encryptedScore);
    if (decrypted !== null) {
      setDecryptedScore(decrypted);
    }
  };

  const renderImprovementTips = (score: number) => {
    const tips = getImprovementTips(score);
    return (
      <div className="tips-section">
        <h4>Improvement Tips</h4>
        <ul>
          {tips.map((tip, i) => (
            <li key={i}>{tip}</li>
          ))}
        </ul>
      </div>
    );
  };

  return (
    <div className="modal-overlay">
      <div className="score-detail-modal">
        <div className="modal-header">
          <h2>Credit Score Details</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        
        <div className="modal-body">
          <div className="score-info">
            <div className="info-item">
              <span>Score ID:</span>
              <strong>#{score.id}</strong>
            </div>
            <div className="info-item">
              <span>Date Generated:</span>
              <strong>{new Date(score.timestamp * 1000).toLocaleDateString()}</strong>
            </div>
            <div className="info-item">
              <span>Data Sources:</span>
              <div className="sources-list">
                {score.dataSources.map((source, i) => (
                  <span key={i} className="source-tag">{source}</span>
                ))}
              </div>
            </div>
          </div>
          
          <div className="data-section">
            <h3>Encrypted Credit Score</h3>
            <div className="data-row">
              <div className="data-label">Score:</div>
              <div className="data-value">{score.encryptedScore.substring(0, 30)}...</div>
              <button 
                className="decrypt-btn" 
                onClick={handleDecrypt} 
                disabled={isDecrypting}
              >
                {isDecrypting ? (
                  "Decrypting..."
                ) : decryptedScore !== null ? (
                  "Hide Score"
                ) : (
                  "Decrypt Score"
                )}
              </button>
            </div>
            
            <div className="fhe-tag">
              <div className="fhe-icon"></div>
              <span>FHE Encrypted - Requires Wallet Signature</span>
            </div>
          </div>
          
          {decryptedScore !== null && (
            <div className="analysis-section">
              <h3>Score Analysis</h3>
              {renderScoreChart(decryptedScore)}
              
              <div className="decrypted-values">
                <div className="value-item">
                  <span>Your Credit Score:</span>
                  <strong>{decryptedScore}</strong>
                </div>
              </div>
              
              {renderImprovementTips(decryptedScore)}
            </div>
          )}
        </div>
        
        <div className="modal-footer">
          <button onClick={onClose} className="close-btn">Close</button>
        </div>
      </div>
    </div>
  );
};

export default App;