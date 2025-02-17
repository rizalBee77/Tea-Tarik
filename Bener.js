const Web3 = require('web3');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const axios = require('axios');
const contractABI = require('./src/abi');
const config = require('./config');
const headers = require('./src/headers');
const { verifyAccountIdentity, verifyWallet, claimOneTimeReward } = require('./src/walletconnect');

const rpcUrl = 'https://rpc.ankr.com/polygon';  // URL provider
const web3 = new Web3(new Web3.providers.HttpProvider(rpcUrl));

// Update with the contract address for TUSDT (Tether) and TPOL (wrapped POL)
const tusdtContractAddress = '0x1E438D4414f38CD2bEB71B73721181CDe019f708';  // TUSDT address
const tpolContractAddress = '0x1Cd0cd01c8C902AdAb3430ae04b9ea32CB309CF1';  // tPOL address

// Define the spender address for TUSDT approval
const spenderAddress = tpolContractAddress; // This contract will be allowed to spend TUSDT

// Initialize contract instances for TUSDT and TPOL
const tusdtContract = new web3.eth.Contract(contractABI, tusdtContractAddress);
const tpolContract = new web3.eth.Contract(contractABI, tpolContractAddress);

const amount = web3.utils.toWei(config.amountToWrap.toString(), 'ether');

// Display header function
function displayHeader() {
  const width = process.stdout.columns;
  const headerLines = [
    "<|============================================|>",
    " Tea-fi Bot ",
    " github.com/recitativonika ",
    "<|============================================|>"
  ];
  headerLines.forEach(line => {
    console.log(`\x1b[36m${line.padStart((width + line.length) / 2)}\x1b[0m`);
  });
}

// Claim daily reward function
async function claimDailyReward(walletAddress, walletNumber) {
  const url = `https://api.tea-fi.com/wallet/check-in/current?address=${walletAddress}`;
  try {
    const response = await Promise.race([
      axios.get(url, { headers }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 10000))
    ]);

    if (response.status === 200) {
      console.log(`\x1b[36m[${walletNumber}]\x1b[0m Claim daily points success!`);
    }
  } catch (error) {
    let errorMessage = error.response ? error.response.data : error.message;
    if (errorMessage.includes('<title>504 Gateway Time-out</title>')) {
      errorMessage = '504 Gateway Time-out';
    }
    console.error(`\x1b[36m[${walletNumber}]\x1b[0m Error claiming daily reward: ${errorMessage}`);
  }
}

// Approve WPOL if needed function
async function approveWPOLIfNeeded(account, walletNumber) {
  try {
    const allowance = await tusdtContract.methods.allowance(account.address, spenderAddress).call();
    const maxUint256 = '1461501637330902918203684832716283019655932542975';  // max uint256 value

    if (allowance < amount) {
      console.log(`\x1b[36m[${walletNumber}]\x1b[0m Approving TUSDT...`);
      const data = tusdtContract.methods.approve(spenderAddress, maxUint256).encodeABI();
      const tx = {
        from: account.address,
        to: tusdtContract.options.address,
        gas: 100000,
        data: data
      };

      const signedTx = await web3.eth.accounts.signTransaction(tx, account.privateKey);
      const receipt = await web3.eth.sendSignedTransaction(signedTx.rawTransaction);
      console.log(`\x1b[36m[${walletNumber}]\x1b[0m TUSDT approved with hash: \x1b[33m${receipt.transactionHash}\x1b[0m`);
    } else {
      console.log(`\x1b[36m[${walletNumber}]\x1b[0m Sufficient TUSDT allowance available.`);
    }
  } catch (error) {
    console.error(`\x1b[36m[${walletNumber}]\x1b[0m Error approving TUSDT:`, error);
  }
}

// Wrap TUSDT to tPOL function
async function wrapTokens(account, walletNumber, numTransactions) {
  try {
    await approveWPOLIfNeeded(account, walletNumber);
    for (let i = 0; i < numTransactions; i++) {
      if (!(await isBalanceSufficient(account, amount, walletNumber))) {
        continue;
      }

      console.log(`\x1b[36m[${walletNumber}]\x1b[0m Executing transaction ${i + 1} of ${numTransactions}`);
      console.log(`\x1b[36m[${walletNumber}]\x1b[0m Converting ${web3.utils.fromWei(amount, 'ether')} TUSDT to tPOL`);

      const data = tpolContract.methods.wrap(amount, account.address).encodeABI();
      const tx = {
        from: account.address,
        to: tpolContractAddress,
        gas: 2000000,
        data: data
      };

      const signedTx = await web3.eth.accounts.signTransaction(tx, account.privateKey);
      const receipt = await web3.eth.sendSignedTransaction(signedTx.rawTransaction);
      console.log(`\x1b[36m[${walletNumber}]\x1b[0m Transaction successful with hash: \x1b[33m${receipt.transactionHash}\x1b[0m`);

      const gasUsed = receipt.gasUsed;
      const gasPrice = await web3.eth.getGasPrice();
      const gasFeeAmount = web3.utils.toBN(gasUsed).mul(web3.utils.toBN(gasPrice)).toString();
      await verifyTransaction(receipt.transactionHash, account.address, gasFeeAmount, walletNumber);
    }
  } catch (error) {
    console.error(`\x1b[36m[${walletNumber}]\x1b[0m Error executing transaction:`, error);
  }
}

// Function to check if balance is sufficient
async function isBalanceSufficient(account, requiredAmount, walletNumber) {
  try {
    const balance = await web3.eth.getBalance(account.address);
    const gasPrice = await web3.eth.getGasPrice();
    const estimatedGas = 2000000; // Estimated gas for the transaction
    const requiredGasFee = web3.utils.toBN(gasPrice).mul(web3.utils.toBN(estimatedGas));

    if (web3.utils.toBN(balance).lt(web3.utils.toBN(requiredAmount).add(requiredGasFee))) {
      console.log(`\x1b[36m[${walletNumber}]\x1b[0m Insufficient balance or gas fee for \x1b[33m${account.address}\x1b[0m. Skipping transaction.`);
      return false;
    }
    return true;
  } catch (error) {
    console.error(`\x1b[36m[${walletNumber}]\x1b[0m Error checking balance:`, error);
    return false;
  }
}

// Main execution function
async function executeMultipleTransactions(autoRestart = false, initialChoice = null, initialNumTransactions = 1, initialPolAmount = 0) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  if (!autoRestart) {
    rl.question('Do you want to auto-restart the process after completion? (y/n): ', async (restartAnswer) => {
      const autoRestart = restartAnswer.trim().toLowerCase();
      if (!['y', 'n'].includes(autoRestart)) {
        console.error('Invalid choice. Please enter "y" or "n".');
        rl.close();
        return;
      }

      await processTransactions(autoRestart === 'y', rl);
    });
  } else {
    await processTransactions(true, rl, initialChoice, initialNumTransactions, initialPolAmount);
  }
}

// Process the transactions
async function processTransactions(autoRestart, rl, initialChoice = null, initialNumTransactions = 1, initialPolAmount = 0) {
  let choice = initialChoice;
  let numTransactions = initialNumTransactions;
  let polAmount = initialPolAmount;

  if (!choice) {
    console.log('1. Convert POL to WPOL');
    console.log('2. Wrap WPOL to tPOL');
    console.log('3. Unwrap all tPOL to WPOL');
    console.log('4. Claim Daily Reward');
    console.log('5. Execute options 2, 3, and 4 sequentially');
    choice = await new Promise(resolve => {
      rl.question('Please select an option (1/2/3/4/5): ', resolve);
    });
  }

  if (!['1', '2', '3', '4', '5'].includes(choice)) {
    console.error('Invalid choice. Please enter "1", "2", "3", "4", or "5".');
    rl.close();
    return;
  }

  // Handle user input for POL amount if needed
  if (choice === '1' && !polAmount) {
    polAmount = await new Promise(resolve => {
      rl.question('How many POL would you like to convert to WPOL? (Example: 0.01) ', (answer) => {
        resolve(parseFloat(answer));
      });
    });
  } else if ((choice === '2' || choice === '5') && numTransactions === 1) {
    numTransactions = await new Promise(resolve => {
      rl.question('How many transactions would you like to execute per account? ', (answer) => {
        resolve(parseInt(answer, 10));
      });
    });
  }

  // Process transactions for each wallet
  const privateKeys = fs.readFileSync(path.join(__dirname, 'priv.txt'), 'utf-8')
    .split('\n')
    .map(key => key.trim())
    .map(key => key.startsWith('0x') ? key.slice(2) : key)
    .filter(key => key.length === 64);

  if (privateKeys.length === 0) {
    console.error('No valid private keys found in priv.txt.');
    rl.close();
    return;
  }

  for (const [index, privateKey] of privateKeys.entries()) {
    const walletNumber = index + 1;
    const account = web3.eth.accounts.privateKeyToAccount(privateKey);
    console.log(`\x1b[36m[${walletNumber}]\x1b[0m Processing transactions for account: \x1b[32m${account.address}\x1b[0m`);

    if (!autoRestart || index === 0) {
      switch (choice) {
        case '1':
          await wrapTokens(account, walletNumber, numTransactions);
          break;
        case '2':
          await wrapTokens(account, walletNumber, numTransactions);
          break;
        case '3':
          // Unwrap function should be added here if required
          break;
        case '4':
          await claimDailyReward(account.address, walletNumber);
          break;
        case '5':
          await wrapTokens(account, walletNumber, numTransactions);
          await claimDailyReward(account.address, walletNumber);
          break;
        default:
          break;
      }
    }
  }

  rl.close();
}

// Execute the process
displayHeader();
executeMultipleTransactions();
        
