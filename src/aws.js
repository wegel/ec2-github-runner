const AWS = require('aws-sdk');
const core = require('@actions/core');
const config = require('./config');

// User data scripts are run as the root user
function buildUserDataScript(githubRegistrationToken, label) {
  const userdata_prefix = [
      '#!/bin/bash',
  ];
  if (config.input.runnerHomeDir) {
    // If runner home directory is specified, we expect the actions-runner software (and dependencies)
    // to be pre-installed in the AMI, so we simply cd into that directory and then start the runner
    userdata_prefix.push(`cd "${config.input.runnerHomeDir}"`);
  } else {
    userdata_prefix.push(
      'mkdir -p actions-runner && cd actions-runner',
      'case $(uname -m) in aarch64) ARCH="arm64" ;; amd64|x86_64) ARCH="x64" ;; esac && export RUNNER_ARCH=${ARCH}',
      'curl -O -L https://github.com/actions/runner/releases/download/v2.280.3/actions-runner-linux-${RUNNER_ARCH}-2.280.3.tar.gz',
      'tar xzf ./actions-runner-linux-${RUNNER_ARCH}-2.280.3.tar.gz',
    );
  }
  // push returns new size of array, so don't use its result as the function return value
  return userdata_prefix.concat(
    'export RUNNER_ALLOW_RUNASROOT=1',
    'export DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1',
    'export INSTANCE_ID=$(cat /var/lib/cloud/data/instance-id)',
    `./config.sh --url https://github.com/${config.githubContext.owner}/${config.githubContext.repo} --token ${githubRegistrationToken} --name "$INSTANCE_ID" --labels ${label}`,
    './run.sh',
  );
}

async function startEc2Instance(label, githubRegistrationToken) {
  const ec2 = new AWS.EC2();

  const userData = buildUserDataScript(githubRegistrationToken, label);

  const params = {
    MinCount: config.input.runnerCount,
    MaxCount: config.input.runnerCount,
    UserData: Buffer.from(userData.join('\n')).toString('base64'),
    TagSpecifications: config.tagSpecifications,
  };

  if (config.input.ec2LaunchTemplate) {
    params.LaunchTemplate = {
      LaunchTemplateName: config.input.ec2LaunchTemplate
    };
  }

  // when using a launch template any or all of these are optional
  if (config.input.ec2ImageId) {
    params.ImageId = config.input.ec2ImageId;
  }
  if (config.input.ec2InstanceType) {
    params.InstanceType = config.input.ec2InstanceType;
  }
  if (config.input.subnetId) {
    params.SubnetId = config.input.subnetId;
  }
  if (config.input.securityGroupId) {
    params.SecurityGroupIds = [config.input.securityGroupId];
  }
  if (config.input.iamRoleName) {
    params.IamInstanceProfile = { Name: config.input.iamRoleName };
  }

  try {
    const result = await ec2.runInstances(params).promise();
    const ec2InstanceIds = result.Instances.map(x => x.InstanceId).join();
    core.info(`AWS EC2 instance ${ec2InstanceIds} started`);
    return ec2InstanceIds;
  } catch (error) {
    core.error('AWS EC2 instance starting error');
    throw error;
  }
}

async function terminateEc2Instance() {
  const ec2 = new AWS.EC2();

  const params = {
    InstanceIds: config.input.ec2InstanceId.split(/\s*,\s*/),
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
    InstanceIds: ec2InstanceId.split(/\s*,\s*/),
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
