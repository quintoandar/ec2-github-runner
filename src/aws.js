const AWS = require('aws-sdk');
const core = require('@actions/core');
const config = require('./config');

// User data scripts are run as the root user
function buildUserDataScript(githubRegistrationToken, label) {
  if (config.input.runnerHomeDir) {
    // If runner home directory is specified, we expect the actions-runner software (and dependencies)
    // to be pre-installed in the AMI, so we simply cd into that directory and then start the runner
    return `
    #!/bin/bash

${config.input.preScript}

su ec2-user -c 'echo "export RUNNER_ALLOW_RUNASROOT=1" >> $HOME/.zshrc'
su ec2-user -c '${config.input.runnerHomeDir}/./config.sh --url ${config.github.url} --token ${githubRegistrationToken} --labels ${label}  --name ${label} --runnergroup default --work "${config.input.runnerHomeDir}" --replace'
su ec2-user -c '${config.input.runnerHomeDir}/./run.sh'
    `;
  } else {
    return `
#!/bin/bash
sudo -u ec2-user -i <<'EOF'

case $(uname -m) in aarch64|arm64) ARCH="arm64" ;; amd64|x86_64) ARCH="x64" ;; esac && export RUNNER_ARCH=$ARCH
case $(uname -a) in Darwin*) OS="osx" ;; Linux*) OS="linux" ;; esac && export RUNNER_OS=$OS

${config.input.preScript}

export VERSION="2.303.0"

curl -L https://github.com/actions/runner/releases/download/v$VERSION/actions-runner-$RUNNER_OS-$RUNNER_ARCH-$VERSION.tar.gz -o /tmp/actions-runner-$RUNNER_OS-$RUNNER_ARCH-$VERSION.tar.gz
echo "export LC_ALL=en_US.UTF-8" >> $HOME/.zshrc
echo "export LANG=en_US.UTF-8" >> $HOME/.zshrc
echo "export RUNNER_ALLOW_RUNASROOT=1" >> $HOME/.zshrc
source $HOME/.zshrc
mkdir /tmp/actions-runner
tar xzf /tmp/actions-runner-$RUNNER_OS-$RUNNER_ARCH-$VERSION.tar.gz -C /tmp/actions-runner --strip-components=1
mv /tmp/actions-runner $HOME/actions-runner
./config.sh --url ${config.github.url} --token ${githubRegistrationToken}  --labels ${label} --name ${label} --runnergroup default --work $(pwd) --replace
./run.sh &
EOF
    `;
  }
}

async function startEc2Instance(label, githubRegistrationToken) {
  const ec2 = new AWS.EC2();

  const userData = buildUserDataScript(githubRegistrationToken, label);

  core.info(userData)
  const params = {
    ImageId: config.input.ec2ImageId,
    InstanceType: config.input.ec2InstanceType,
    MinCount: 1,
    MaxCount: 1,
    UserData: Buffer.from(userData).toString('base64'),
    SubnetId: config.input.subnetId,
    SecurityGroupIds: [config.input.securityGroupId],
    IamInstanceProfile: { Name: config.input.iamRoleName },
    TagSpecifications: config.tagSpecifications,
  };

  if (config.input.hostId) {
    params.Placement = {
      Tenancy: 'host',
      HostId: config.input.hostId
    }
  }

  try {
    const result = await ec2.runInstances(params).promise();
    const ec2InstanceId = result.Instances[0].InstanceId;
    core.info(`AWS EC2 instance ${ec2InstanceId} is started`);
    return ec2InstanceId;
  } catch (error) {
    core.error('AWS EC2 instance starting error');
    throw error;
  }
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
