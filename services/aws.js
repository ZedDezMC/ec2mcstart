const { EC2Client, DescribeInstancesCommand, StartInstancesCommand, StopInstancesCommand } = require('@aws-sdk/client-ec2');
const { SSMClient, SendCommandCommand } = require('@aws-sdk/client-ssm');

// Khởi tạo SDK Clients với credentials từ .env
const getCredentials = () => {
  const region = process.env.AWS_REGION || 'ap-southeast-1';
  const config = { region };

  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    config.credentials = {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    };
  }
  return config;
};

const ec2Client = new EC2Client(getCredentials());
const ssmClient = new SSMClient(getCredentials());

/**
 * Lấy trạng thái hiện tại của EC2 Instance & Public IP (nếu có)
 */
async function getInstanceStatus(instanceId) {
  try {
    const command = new DescribeInstancesCommand({ InstanceIds: [instanceId] });
    const response = await ec2Client.send(command);

    if (!response.Reservations || response.Reservations.length === 0 || !response.Reservations[0].Instances[0]) {
      throw new Error(`Khong tim thay ID: ${instanceId}`);
    }

    const instance = response.Reservations[0].Instances[0];
    const state = instance.State ? instance.State.Name : 'unknown';
    const publicIp = instance.PublicIpAddress || instance.PublicDnsName || null;

    return {
      state, // 'pending' | 'running' | 'shutting-down' | 'terminated' | 'stopping' | 'stopped'
      publicIp
    };
  } catch (error) {
    console.error('Loi khi check status:', error);
    throw error;
  }
}

/**
 * Gửi yêu cầu khởi động EC2 Instance
 */
async function startInstance(instanceId) {
  try {
    const command = new StartInstancesCommand({ InstanceIds: [instanceId] });
    const response = await ec2Client.send(command);
    const startingInstance = response.StartingInstances ? response.StartingInstances[0] : null;

    return {
      success: true,
      previousState: startingInstance ? startingInstance.PreviousState.Name : 'unknown',
      currentState: startingInstance ? startingInstance.CurrentState.Name : 'pending'
    };
  } catch (error) {
    console.error('Loi khi start:', error);
    throw error;
  }
}

/**
 * Gửi yêu cầu tắt EC2 Instance
 */
async function stopInstance(instanceId) {
  try {
    const command = new StopInstancesCommand({ InstanceIds: [instanceId] });
    const response = await ec2Client.send(command);
    const stoppingInstance = response.StoppingInstances ? response.StoppingInstances[0] : null;

    return {
      success: true,
      previousState: stoppingInstance ? stoppingInstance.PreviousState.Name : 'unknown',
      currentState: stoppingInstance ? stoppingInstance.CurrentState.Name : 'stopping'
    };
  } catch (error) {
    console.error('Loi khi stop EC2 Instance:', error);
    throw error;
  }
}

/**
 * Chạy lệnh khởi động Minecraft Server trên VPS qua AWS SSM RunCommand
 */
async function runSSMStartMinecraftCommand(instanceId, shellCommand) {
  try {
    const command = new SendCommandCommand({
      InstanceIds: [instanceId],
      DocumentName: 'AWS-RunShellScript',
      Parameters: {
        commands: [shellCommand]
      }
    });

    const response = await ssmClient.send(command);
    console.log(`sent cmd success: ${response.Command.CommandId}`);
    return {
      success: true,
      commandId: response.Command.CommandId
    };
  } catch (error) {
    console.error('cant send req:', error);
    if (error.name === 'InvalidInstanceId' || (error.message && error.message.includes('not in a valid state'))) {
      throw new Error(`env not set correctly: (${instanceId})`);
    }
    throw error;
  }
}

module.exports = {
  getInstanceStatus,
  startInstance,
  stopInstance,
  runSSMStartMinecraftCommand
};
