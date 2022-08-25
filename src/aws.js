const AWS = require('aws-sdk');
const yaml = require('js-yaml');
const core = require('@actions/core');
const config = require('./config');

// User data scripts are run as the root user
function buildUserDataScript(githubRegistrationToken, label) {
  return [
    '#!/bin/bash',
    `if [ ! -d "${config.input.runnerHomeDir}" ]; then`,
    `  mkdir -p "${config.input.runnerHomeDir}" && cd "${config.input.runnerHomeDir}"`,
    '  case $(uname -m) in aarch64) ARCH="arm64" ;; amd64|x86_64) ARCH="x64" ;; esac && export RUNNER_ARCH=${ARCH}',
    '  curl -O -L https://github.com/actions/runner/releases/download/v2.286.0/actions-runner-linux-${RUNNER_ARCH}-2.286.0.tar.gz',
    '  tar xzf ./actions-runner-linux-${RUNNER_ARCH}-2.286.0.tar.gz',
    '  cd -',
    'fi',
    `cd ${config.input.runnerHomeDir}`,
    'export RUNNER_ALLOW_RUNASROOT=1',
    `./config.sh --url https://github.com/${config.githubContext.owner}/${config.githubContext.repo} --token ${githubRegistrationToken} --labels ${label}`,
    './run.sh',
  ];
}

async function startEc2Instance(label, githubRegistrationToken) {
  const ec2 = new AWS.EC2();

  const userData = buildUserDataScript(githubRegistrationToken, label);

  const params = Object.assign({},
    { UserData: Buffer.from(userData.join('\n')).toString('base64') },
    { MinCount: 1} ,
    { MaxCount: 1 },
    config.tagSpecifications && { TagSpecifications: config.tagSpecifications },
    yaml.load(config.input.ec2LaunchParams)
  );

  let paramsList = [params]
  if (config.input.ec2TrySpotFirst === 'true') {
    const spotParams = Object.assign({}, params, { InstanceMarketOptions: { MarketType: 'spot' }});
    paramsList = [spotParams, params]
  }

  let lastError = null;
  for(let i = 0; i < paramsList.length; i++) {
    core.info(`Trying launch parameters ${i + 1} of ${paramsList.length}`);
    try {
      const result = await ec2.runInstances(paramsList[i]).promise();
      const ec2InstanceId = result.Instances[0].InstanceId;
      core.info(`AWS EC2 instance ${ec2InstanceId} is started`);
      return ec2InstanceId;
    } catch (error) {
      lastError = error;
      core.warning(`AWS EC2 instance start error: ${error.message}`);
    }
  }

  core.error('AWS EC2 instance starting error');
  throw lastError;
}

async function terminateEc2Instance() {
  const ec2 = new AWS.EC2();

  const params = {
    InstanceIds: [config.input.ec2InstanceId],
  };

  try {
    await ec2.terminateInstances(params).promise();
    core.info(`AWS EC2 instance ${config.input.ec2InstanceId} is terminated`);
    return;
  } catch (error) {
    core.error(`AWS EC2 instance ${config.input.ec2InstanceId} termination error`);
    throw error;
  }
}

async function waitForInstanceRunning(ec2InstanceId) {
  const ec2 = new AWS.EC2();

  const params = {
    InstanceIds: [ec2InstanceId],
  };

  try {
    await ec2.waitFor('instanceRunning', params).promise();
    core.info(`AWS EC2 instance ${ec2InstanceId} is up and running`);
    return;
  } catch (error) {
    core.error(`AWS EC2 instance ${ec2InstanceId} initialization error`);
    throw error;
  }
}

module.exports = {
  startEc2Instance,
  terminateEc2Instance,
  waitForInstanceRunning,
};
