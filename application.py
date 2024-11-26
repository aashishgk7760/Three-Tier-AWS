from flask import Flask, render_template, jsonify
import boto3
from botocore.exceptions import ClientError
from datetime import datetime
import logging

application = Flask(__name__)
logging.basicConfig(level=logging.INFO)

# AWS credentials should be configured via environment variables or IAM role
def get_aws_client(service):
    return boto3.client(service, region_name='us-east-2')

def get_asg_instance_details(asg_name):
    try:
        asg_client = get_aws_client('autoscaling')
        response = asg_client.describe_auto_scaling_groups(
            AutoScalingGroupNames=[asg_name]
        )
        
        if not response['AutoScalingGroups']:
            logging.warning(f"Auto Scaling group '{asg_name}' not found.")
            return []

        instances = response['AutoScalingGroups'][0]['Instances']
        instance_details = []
        for instance in instances:
            instance_details.append({
                'id': instance['InstanceId'],
                'lifecycle_state': instance['LifecycleState']
            })
        return instance_details
    except Exception as e:
        logging.error(f"Error fetching Auto Scaling group details: {str(e)}")
        return []

def get_instance_details():
    try:
        ec2_client = get_aws_client('ec2')
        asg_name = ""
        asg_instances = get_asg_instance_details(asg_name)
        
        asg_instance_dict = {instance['id']: instance['lifecycle_state'] for instance in asg_instances}
        
        instances = ec2_client.describe_instances(
            Filters=[
                {
                    'Name': 'instance-state-name',
                    'Values': ['pending', 'running', 'stopping', 'stopped', 'shutting-down']
                },
                {
                    'Name': 'tag:Name',
                    'Values': ['NetworkStack/WebLayer-LaunchTemplate-v3']
                }
            ]
        )
        instance_list = []
        for reservation in instances['Reservations']:
            for instance in reservation['Instances']:
                instance_info = {
                    'id': instance['InstanceId'],
                    'state': instance['State']['Name'],
                    'az': instance['Placement']['AvailabilityZone'],
                    'type': instance['InstanceType'],
                    'lifecycle_state': asg_instance_dict.get(instance['InstanceId'], 'Not in ASG')
                }
                instance_list.append(instance_info)
        return instance_list
    except Exception as e:
        logging.error(f"Error fetching instance details: {str(e)}")
        return []

def get_load_balancer_info():
    try:
        elb_client = get_aws_client('elbv2')
        load_balancers = elb_client.describe_load_balancers()
        if load_balancers['LoadBalancers']:
            lb = load_balancers['LoadBalancers'][0]  # Get first LB
            return {
                'name': lb['LoadBalancerName'],
                'dns': lb['DNSName'],
                'arn': lb['LoadBalancerArn']
            }
        return None
    except Exception as e:
        logging.error(f"Error fetching load balancer info: {str(e)}")
        return None

def get_cpu_utilization():
    try:
        cloudwatch = get_aws_client('cloudwatch')
        response = cloudwatch.get_metric_statistics(
            Namespace='AWS/EC2',
            MetricName='CPUUtilization',
            Dimensions=[{'Name': 'AutoScalingGroupName', 'Value': 'NetworkStack-webAutoscalingGroupversion2ASGEA55C195-qRus1wqRIN1E'}],
            StartTime=datetime.utcnow().replace(minute=0, second=0, microsecond=0),
            EndTime=datetime.utcnow(),
            Period=60,
            Statistics=['Average']
        )
        if response['Datapoints']:
            return round(response['Datapoints'][-1]['Average'], 1)
        return 0.0
    except Exception as e:
        logging.error(f"Error fetching CPU utilization: {str(e)}")
        return 0.0

def get_database_az():
    try:
        rds_client = get_aws_client('rds')
        db_instances = rds_client.describe_db_instances()
        if db_instances['DBInstances']:
            return db_instances['DBInstances'][0]['AvailabilityZone']
        return 'N/A'
    except Exception as e:
        logging.error(f"Error fetching database AZ: {str(e)}")
        return 'Error'

@application.route('/')
def index():
    instances = get_instance_details()
    lb_info = get_load_balancer_info()
    cpu_utilization = get_cpu_utilization()
    db_az = get_database_az()
    return render_template('index.html',
                           instances=instances,
                           lb_info=lb_info,
                           cpu_utilization=cpu_utilization,
                           total_instances=len(instances),
                           db_az=db_az)

@application.route('/update_data')
def update_data():
    instances = get_instance_details()
    lb_info = get_load_balancer_info()
    cpu_utilization = get_cpu_utilization()
    db_az = get_database_az()
    return jsonify({
        'instances': instances,
        'lb_info': lb_info,
        'cpu_utilization': cpu_utilization,
        'total_instances': len(instances),
        'db_az': db_az
    })

if __name__ == '__main__':
    application.run(debug=True,port=5000)
