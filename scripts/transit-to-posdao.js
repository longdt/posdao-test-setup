const assert = require('assert');
const fs = require('fs');
const exec = require('child_process').exec;
const { promisify } = require('util');
const solc = require('solc');
const Web3 = require('web3');
const providerUrl = 'ws://localhost:9541';
const web3 = new Web3(providerUrl);
const BN = web3.utils.BN;

async function main() {
  // Ensure the current POA BlockReward contract is working
  console.log('Checking old BlockReward...');
  const oldBlockRewardContractCompiled = await compile(
    __dirname + '/../poa-contracts/',
    'BlockReward'
  );
  const oldBlockRewardContract = new web3.eth.Contract(
    oldBlockRewardContractCompiled.abi,
    getOldBlockRewardContractAddress()
  );
  const lastBlockProcessed = await oldBlockRewardContract.methods.lastBlockProcessed().call();
  assert(lastBlockProcessed == await web3.eth.getBlockNumber() && lastBlockProcessed != 0);

  console.log('Deploying STAKE token contract...');

  // Compile STAKE token contract
  const tokenContractCompiled = await compile(
    __dirname + '/../posdao-contracts/test/mockContracts/',
    'ERC677BridgeTokenRewardableMock'
  );

  // Deploy STAKE token contract
  let tokenContract = new web3.eth.Contract(tokenContractCompiled.abi);
  tokenContract = await tokenContract
    .deploy({
      data: tokenContractCompiled.bytecode,
      arguments: ['STAKE', 'STAKE', 18]
    })
    .send({
      from: process.env.OWNER,
      gas: '4700000',
      gasPrice: '0'
    });
  console.log(`  address: ${tokenContract.options.address}`);

  // Build and deploy POSDAO contracts
  const validatorSetContract = await deploy('ValidatorSetAuRa');
  const stakingContract = await deploy('StakingAuRa');
  const blockRewardContract = await deploy('BlockRewardAuRa');
  const randomContract = await deploy('RandomAuRa');
  const txPermissionContract = await deploy('TxPermission');
  const certifierContract = await deploy('Certifier');
  const registryContract = await deploy('Registry', [
    certifierContract.options.address,
    process.env.OWNER
  ]);

  // Initialize POSDAO contracts
  let miningAddresses = process.env.INITIAL_VALIDATORS.split(',');
  for (let i = 0; i < miningAddresses.length; i++) {
    miningAddresses[i] = miningAddresses[i].trim();
  }
  let stakingAddresses = process.env.STAKING_ADDRESSES.split(',');
  for (let i = 0; i < stakingAddresses.length; i++) {
    stakingAddresses[i] = stakingAddresses[i].trim();
  }

  const txSendOptions = {
    from: process.env.OWNER,
    gas: '1000000',
    gasPrice: '0'
  };

  console.log('Initialize ValidatorSet contract...');
  await validatorSetContract.methods.initialize(
    blockRewardContract.options.address,
    randomContract.options.address,
    stakingContract.options.address,
    miningAddresses,
    stakingAddresses,
    process.env.FIRST_VALIDATOR_IS_UNREMOVABLE === 'true'
  ).send(txSendOptions);
  assert(await validatorSetContract.methods.isInitialized().call());
  assert(await validatorSetContract.methods.blockRewardContract().call() == blockRewardContract.options.address);
  assert(await validatorSetContract.methods.randomContract().call() == randomContract.options.address);
  assert(await validatorSetContract.methods.stakingContract().call() == stakingContract.options.address);
  assert((await validatorSetContract.methods.getValidators().call()).equalsIgnoreCase(miningAddresses));
  assert((await validatorSetContract.methods.getPendingValidators().call()).equalsIgnoreCase(miningAddresses));
  if (process.env.FIRST_VALIDATOR_IS_UNREMOVABLE === 'true') {
    assert((await validatorSetContract.methods.unremovableValidator().call()).equalsIgnoreCase(stakingAddresses[0]));
  } else {
    assert((await validatorSetContract.methods.unremovableValidator().call()).equalsIgnoreCase('0x0000000000000000000000000000000000000000'));
  }
  for (let i = 0; i < miningAddresses.length; i++) {
    assert(await validatorSetContract.methods.isValidator(miningAddresses[i]).call());
    assert((await validatorSetContract.methods.stakingByMiningAddress(miningAddresses[i]).call()).equalsIgnoreCase(stakingAddresses[i]));
  }

  const currentBlock = await web3.eth.getBlockNumber();
  const approximateTransitionBlock = currentBlock + 31; // we take 31 blocks to finish initialization and let the nodes restart
  const stakingEpochStartBlock = Math.ceil(approximateTransitionBlock / process.env.COLLECT_ROUND_LENGTH) * process.env.COLLECT_ROUND_LENGTH + 1;

  const delegatorMinStake = web3.utils.toWei(new BN(1000), 'ether');
  const candidateMinStake = web3.utils.toWei(new BN(20000), 'ether');

  console.log('Initialize Staking contract...');
  await stakingContract.methods.initialize(
    validatorSetContract.options.address,
    stakingAddresses,
    delegatorMinStake,
    candidateMinStake,
    process.env.STAKING_EPOCH_DURATION,
    stakingEpochStartBlock,
    process.env.STAKE_WITHDRAW_DISALLOW_PERIOD
  ).send(txSendOptions);
  await stakingContract.methods.setErc677TokenContract(
    tokenContract.options.address
  ).send(txSendOptions);
  await tokenContract.methods.setStakingContract(
    stakingContract.options.address
  ).send(txSendOptions);
  assert(await stakingContract.methods.isInitialized().call());
  assert(await stakingContract.methods.validatorSetContract().call() == validatorSetContract.options.address);
  assert(await stakingContract.methods.delegatorMinStake().call() == delegatorMinStake);
  assert(await stakingContract.methods.candidateMinStake().call() == candidateMinStake);
  assert(await stakingContract.methods.stakingEpochDuration().call() == process.env.STAKING_EPOCH_DURATION);
  assert(await stakingContract.methods.stakingEpochStartBlock().call() == stakingEpochStartBlock);
  assert(await stakingContract.methods.stakeWithdrawDisallowPeriod().call() == process.env.STAKE_WITHDRAW_DISALLOW_PERIOD);
  assert((await stakingContract.methods.getPools().call()).equalsIgnoreCase(stakingAddresses));
  assert(await stakingContract.methods.erc677TokenContract().call() == tokenContract.options.address);
  assert(await tokenContract.methods.stakingContract().call() == stakingContract.options.address);

  console.log('Initialize BlockReward contract...');
  await blockRewardContract.methods.initialize(
    validatorSetContract.options.address,
    oldBlockRewardContract.options.address
  ).send(txSendOptions);
  await blockRewardContract.methods.setErcToNativeBridgesAllowed(
    ['0x7301CFA0e1756B71869E93d4e4Dca5c7d0eb0AA6']
  ).send(txSendOptions);
  await tokenContract.methods.setBlockRewardContract(
    blockRewardContract.options.address
  ).send(txSendOptions);
  assert(await blockRewardContract.methods.isInitialized().call());
  assert(await blockRewardContract.methods.validatorSetContract().call() == validatorSetContract.options.address);
  assert((await blockRewardContract.methods.ercToNativeBridgesAllowed().call()).equalsIgnoreCase(['0x7301CFA0e1756B71869E93d4e4Dca5c7d0eb0AA6']));
  assert(await tokenContract.methods.blockRewardContract().call() == blockRewardContract.options.address);

  console.log('Initialize Random contract...');
  await randomContract.methods.initialize(
    process.env.COLLECT_ROUND_LENGTH,
    validatorSetContract.options.address
  ).send(txSendOptions);
  assert(await randomContract.methods.isInitialized().call());
  assert(await randomContract.methods.validatorSetContract().call() == validatorSetContract.options.address);
  assert(await randomContract.methods.collectRoundLength().call() == process.env.COLLECT_ROUND_LENGTH);

  console.log('Initialize TxPermission contract...');
  await txPermissionContract.methods.initialize(
    [process.env.OWNER],
    validatorSetContract.options.address
  ).send(txSendOptions);
  assert(await txPermissionContract.methods.isInitialized().call());
  assert(await txPermissionContract.methods.validatorSetContract().call() == validatorSetContract.options.address);
  assert(await txPermissionContract.methods.isSenderAllowed(process.env.OWNER).call());
  assert((await txPermissionContract.methods.allowedSenders().call()).equalsIgnoreCase([process.env.OWNER]));

  console.log('Initialize Certifier contract...');
  await certifierContract.methods.initialize(
    [process.env.OWNER],
    validatorSetContract.options.address
  ).send(txSendOptions);
  assert(await certifierContract.methods.isInitialized().call());
  assert(await certifierContract.methods.validatorSetContract().call() == validatorSetContract.options.address);
  assert(await certifierContract.methods.certified(process.env.OWNER).call());

  console.log('Mint and stake initial tokens...');
  const mintAmount = candidateMinStake.mul(new BN(stakingAddresses.length));
  await tokenContract.methods.mint(
    stakingContract.options.address,
    mintAmount
  ).send(txSendOptions);
  assert((new BN(await tokenContract.methods.totalSupply().call())).eq(mintAmount));
  assert((new BN(await tokenContract.methods.balanceOf(stakingContract.options.address).call())).eq(mintAmount));
  await stakingContract.methods.initialValidatorStake(
    mintAmount
  ).send(txSendOptions);
  for (let i = 0; i < stakingAddresses.length; i++) {
    assert((new BN(await stakingContract.methods.stakeAmount(stakingAddresses[i], stakingAddresses[i]).call())).eq(candidateMinStake));
  }

  console.log('Change spec.json...');
  let spec = readSpec();
  spec.engine.authorityRound.params.validators.multi[stakingEpochStartBlock] = { "contract" : validatorSetContract.options.address };
  spec.engine.authorityRound.params.blockRewardContractTransitions = {};
  spec.engine.authorityRound.params.blockRewardContractTransitions[stakingEpochStartBlock] = blockRewardContract.options.address;
  spec.engine.authorityRound.params.randomnessContractAddress = {};
  spec.engine.authorityRound.params.randomnessContractAddress[stakingEpochStartBlock] = randomContract.options.address;
  spec.engine.authorityRound.params.posdaoTransition = stakingEpochStartBlock;
  spec.params.registrar = registryContract.options.address;
  spec.params.transactionPermissionContract = txPermissionContract.options.address;
  spec.params.transactionPermissionContractTransition = stakingEpochStartBlock;
  writeSpec(spec);

  console.log('Restarting the nodes randomly...');
  const nodeIndexes = shuffle([0,1,2,3,4,5,6]);
  for (let n = 0; n <= 6; n++) {
    const i = nodeIndexes[n];

    console.log(`  Restarting the node # ${i}...`);
    let result = await promisify(exec)(`lsof -t -i:854${i}`);
    const pid = result.stdout.trim();

    if (pid) {
      await promisify(exec)(`kill ${pid}`);
      await sleep(5000); // wait for 5 seconds
    } else {
      throw Error(`Cannot stop the node # ${i}`);
    }

    await promisify(exec)(`../parity-ethereum/target/release/parity --config "./config/node${i}.toml" >> "./parity-data/node${i}/log" 2>&1 &`);

    let newPid = null;
    let steps;
    for (steps = 1; steps <= 10; steps++) {
      await sleep(1000); // wait for a second
      try {
        result = await promisify(exec)(`lsof -t -i:854${i}`);
        newPid = result.stdout.trim();
      } catch(e) {}
      if (newPid) {
        break;
      }
    }

    if (!newPid || newPid == pid) {
      throw Error(`Cannot restart the node # ${i}`);
    } else if (steps < 5) {
      await sleep((5 - steps) * 1000); // ensure the pause was at least 5 seconds
    }
  }

  if (!isConnected()) {
    web3.setProvider(new Web3.providers.WebsocketProvider(providerUrl));
  }

  console.log('');
  console.log(`CURRENT BLOCK: ${await web3.eth.getBlockNumber()}`);
  console.log(`POSDAO TRANSITION BLOCK: ${stakingEpochStartBlock}`);
  console.log('');

  console.log('Waiting for the POSDAO transition...');

  process.exit();
}

async function compile(dir, contractName) {
  const input = {
    language: 'Solidity',
    sources: {
      '': {
        content: fs.readFileSync(dir + contractName + '.sol').toString()
      }
    },
    settings: {
      optimizer: {
        enabled: true,
        runs: 200
      },
      evmVersion: "constantinople",
      outputSelection: {
        '*': {
          '*': [ 'abi', 'evm.bytecode.object', 'evm.methodIdentifiers' ]
        }
      }
    }
  }

  const compiled = JSON.parse(solc.compile(JSON.stringify(input), function(path) {
    let content;
    try {
      content = fs.readFileSync(dir + path);
    } catch (e) {
      if (e.code == 'ENOENT') {
        try {
          content = fs.readFileSync(dir + '../' + path);
        } catch (e) {
          content = fs.readFileSync(dir + '../node_modules/' + path);
        }
      }
    }
    return {
      contents: content.toString()
    }
  }));

  const result = compiled.contracts[''][contractName];
  return { abi: result.abi, bytecode: '0x' + result.evm.bytecode.object };
}

async function deploy(contractName, constructorArguments = null) {
  const upgradable = constructorArguments === null;

  console.log(`Deploying ${contractName} contract...`);
  const contractJSON = require(__dirname + '/../posdao-contracts/build/contracts/' + contractName);
  let contract = new web3.eth.Contract(contractJSON.abi);
  contract = await contract
    .deploy({
      data: contractJSON.bytecode,
      arguments: constructorArguments
    })
    .send({
      from: process.env.OWNER,
      gas: '4700000',
      gasPrice: '0'
    });

  if (!upgradable) {
    console.log(`  address: ${contract.options.address}`);
  } else {
    console.log(`  implementation address: ${contract.options.address}`);

    const adminUpgradeabilityProxyJSON = require(__dirname + '/../posdao-contracts/build/contracts/AdminUpgradeabilityProxy');
    const adminUpgradeabilityProxy = new web3.eth.Contract(adminUpgradeabilityProxyJSON.abi);

    contract = await adminUpgradeabilityProxy
      .deploy({
        data: adminUpgradeabilityProxyJSON.bytecode,
        arguments: [
          contract.options.address, // implementation address
          process.env.OWNER, // admin (owner)
          []
        ]
      })
      .send({
        from: process.env.OWNER,
        gas: '4700000',
        gasPrice: '0'
      });
    contract = new web3.eth.Contract(contractJSON.abi, contract.options.address);
    console.log(`  proxy address: ${contract.options.address}`);
  }

  return contract;
}

function getOldBlockRewardContractAddress() {
  return readSpec().engine.authorityRound.params.blockRewardContractAddress;
}

function isConnected() {
  const connection = web3.currentProvider.connection;
  return connection.readyState == connection.OPEN;
}

function readSpec() {
  const spec = fs.readFileSync(__dirname + '/../parity-data/spec.json', 'utf8');
  assert(typeof spec === 'string');
  return JSON.parse(spec);
}

function shuffle(a) {
  var j, x, i;
  for (i = a.length - 1; i > 0; i--) {
    j = Math.floor(Math.random() * (i + 1));
    x = a[i];
    a[i] = a[j];
    a[j] = x;
  }
  return a;
}

async function sleep(ms) {
  await new Promise(r => setTimeout(r, ms));
}

function writeSpec(spec) {
  fs.writeFileSync(__dirname + '/../parity-data/spec.json', JSON.stringify(spec, null, '  '), 'UTF-8');
}

Array.prototype.equalsIgnoreCase = function(array) {
  return this.length == array.length && this.every((this_v, i) => { return this_v.equalsIgnoreCase(array[i]) });
}

String.prototype.equalsIgnoreCase = function(compareString) {
  return this.toLowerCase() === compareString.toLowerCase(); 
}; 

main();
