import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as iam from "aws-cdk-lib/aws-iam";
import * as vpc from "aws-cdk-lib/aws-ec2";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as autoscaling from "aws-cdk-lib/aws-autoscaling";
import * as rds from "aws-cdk-lib/aws-rds";
import * as r53 from "aws-cdk-lib/aws-route53";
import * as appauto from "aws-cdk-lib/aws-applicationautoscaling";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as sec from "aws-cdk-lib/aws-secretsmanager";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront"
import * as origins from "aws-cdk-lib/aws-cloudfront-origins"

// import * as sqs from 'aws-cdk-lib/aws-sqs';

export class NetworkEastStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);


    const iamROleforEc2 = new iam.Role(this, "IamRoleforWebservers", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonS3ReadOnlyAccess"),
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "AmazonSSMManagedInstanceCore"
        ),
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "CloudWatchActionsEC2Access"
        ),
      ],
    });

    //instance profile 
    const instanceProfile = new iam.CfnInstanceProfile(
      this,
      "instanceProfile",
      {
        roles: [iamROleforEc2.roleName],
      }
    );

    //Network services

    const threeTierVpc = new ec2.Vpc(this, "ThreeTierVpc", {
      cidr: "10.0.0.0/16",
      natGateways: 2,
      enableDnsHostnames: true,
      enableDnsSupport: true,
      maxAzs: 2,
      subnetConfiguration: [
        {
          name: "Web-tier",
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
          mapPublicIpOnLaunch: true,
        },
        {
          name: "app-tier",
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
        {
          name: "data-tier",
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });
    cdk.Tags.of(threeTierVpc).add("Name", "threeTierVpc");

    const vpcFlowlogsBucket = new s3.Bucket(this, "testBucket",{
      bucketName: "demobucketforvppcflowlogsforab",
      autoDeleteObjects: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    })

    //create a vpc flow logs
    const vpcFlowLogs = new ec2.FlowLog(this, "VPCFlowLogs", {
      resourceType: ec2.FlowLogResourceType.fromVpc(threeTierVpc),
      trafficType: ec2.FlowLogTrafficType.ALL,
      destination: ec2.FlowLogDestination.toS3(vpcFlowlogsBucket),
    });


      const ALBSG = new ec2.SecurityGroup(this, "ExternalALBSecurityGroup", {
        vpc: threeTierVpc,
        allowAllOutbound: true,
        description: "Security Group for Application Load balancer",
        securityGroupName: "ALBSecurityGroup",
      });
      ALBSG.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), "allow http");
      ALBSG.addIngressRule(
        ec2.Peer.anyIpv4(),
        ec2.Port.tcp(443),
        "allow https"
      );

    // //DB params

    //Web Tier Security Group
    const webappSG = new ec2.SecurityGroup(this, "WebServerSecurityGroup", {
      vpc: threeTierVpc,
      allowAllOutbound: true,
      description: "Security Group for Web Servers",
      securityGroupName: "WebServerSecurityGroup",
    });
 
    webappSG.addIngressRule(ec2.Peer.securityGroupId(ALBSG.securityGroupId), ec2.Port.tcp(80))

    const lauchTemp = new ec2.LaunchTemplate(this, "WebLayer-LaunchTemplate-v3", {
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T2,
        ec2.InstanceSize.MICRO
      ),
      role: iamROleforEc2,
      machineImage: ec2.MachineImage.fromSsmParameter("WebServerAMI"),
      securityGroup: webappSG,
    });
    // Auto Scaling Group for Web Servers
    const webAutoscaling = new autoscaling.AutoScalingGroup(
      this,
      "webAutoscalingGroup-version3",
      {
        vpc: threeTierVpc,
        launchTemplate: lauchTemp,
        maxCapacity: 5,
        minCapacity: 2,
        desiredCapacity: 2,
        vpcSubnets: {
          subnetType: ec2.SubnetType.PUBLIC,
        },
        terminationPolicies: [
          autoscaling.TerminationPolicy.OLDEST_LAUNCH_TEMPLATE,
        ],

        cooldown: cdk.Duration.seconds(60),
      

      }
    
    );


    


   


    //     // Load Balancer for Web Servers

    const WebAppALB = new elbv2.ApplicationLoadBalancer(
      this,
      "WebAppLoadBalancer",
      {
        vpc: threeTierVpc,
        internetFacing: true,
        vpcSubnets: {
          subnetType: ec2.SubnetType.PUBLIC,
        },
        loadBalancerName: "WebAppALB",
        securityGroup: ALBSG,
      }
    );
    const listerner = new elbv2.ApplicationListener(this, "listner", {
      port: 80,
      open: true,
      loadBalancer: WebAppALB,
    });
    listerner.addTargets("WebAPPListerners", {
      port: 80,
      targets: [webAutoscaling],
      protocol: elbv2.ApplicationProtocol.HTTP,
      healthCheck: {
        enabled: true,
        path: "/",
        port: "80",
        protocol: elbv2.Protocol.HTTP,
        healthyHttpCodes: "200",
        healthyThresholdCount: 5,
        interval: cdk.Duration.seconds(30),
        unhealthyThresholdCount: 2,
      },
    });

     const interALBSG = new ec2.SecurityGroup(
       this,
       "InternalLoadBalancerSecurityGroup",
       {
         vpc: threeTierVpc,
         allowAllOutbound: true,
         description: "security group for Internal Loadbalancer",
         securityGroupName: "InternalLoadBalancerSecurityGroup",
       }
     );

     interALBSG.addIngressRule(
       ec2.Peer.securityGroupId(webappSG.securityGroupId),
       ec2.Port.tcp(80),
       "allow http"
     );

    // //APP LAYER

    const AppSecGroup = new ec2.SecurityGroup(
      this,
      "ApplicationSecurityGroup",
      {
        vpc: threeTierVpc,
        allowAllOutbound: true,
        description: "security group for Application Servers",
        securityGroupName: "ApplicationSecurityGroup",
      }
    );
    AppSecGroup.addIngressRule(
      ec2.Peer.securityGroupId(interALBSG.securityGroupId),
      ec2.Port.tcp(4000),
      "allow http"
    );

    const AppLaunchTemplate = new ec2.LaunchTemplate(
      this,
      "AppServers-Launch-Template-v2",
      {
        instanceType: ec2.InstanceType.of(
          ec2.InstanceClass.T2,
          ec2.InstanceSize.MICRO
        ),
        machineImage: ec2.MachineImage.fromSsmParameter("ab2applayer"),
        securityGroup: AppSecGroup,
        role: iamROleforEc2,
      }
    );

    //created image on 22nd oct
    const AppAutoscaling = new autoscaling.AutoScalingGroup(
      this,
      "AppAutoscalingGroups-App-v2",
      {
        vpc: threeTierVpc,
        launchTemplate: AppLaunchTemplate,
        maxCapacity: 5,
        minCapacity: 2,
        desiredCapacity: 2,
        vpcSubnets: {
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
      }
    );
    AppAutoscaling.scaleOnCpuUtilization("CpuScaling", {
      targetUtilizationPercent: 50,

    });

    const InternalALB = new elbv2.ApplicationLoadBalancer(this, "InternalALBforApp", {
      vpc: threeTierVpc,
      ipAddressType: elbv2.IpAddressType.IPV4,
      internetFacing: false,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      loadBalancerName: "InternalALB",
      securityGroup: interALBSG,
    });

    const listerner2 = new elbv2.ApplicationListener(this, "listner2", {
      port: 80,
      open: true,
      loadBalancer: InternalALB,
    });
    listerner2.addTargets("AppAutoscaling", {
      port: 4000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [AppAutoscaling],
      healthCheck: {
        enabled: true,
        path: "/health",
        port: "4000",
        protocol: elbv2.Protocol.HTTP,
        healthyHttpCodes: "200",
        healthyThresholdCount: 5,
        interval: cdk.Duration.seconds(30),
        unhealthyThresholdCount: 2,
      },
      targetGroupName: "AppAutoscaling",
      loadBalancingAlgorithmType: elbv2.TargetGroupLoadBalancingAlgorithmType.ROUND_ROBIN,
      stickinessCookieDuration: cdk.Duration.seconds(8600),
      deregistrationDelay: cdk.Duration.seconds(300),
      slowStart: cdk.Duration.seconds(0),

    });

    const DBSG = new ec2.SecurityGroup(this, "DBSG", {
      vpc: threeTierVpc,
      allowAllOutbound: true,
      description: "Database Security Group",
      securityGroupName: "DBSG",
    });

    DBSG.addIngressRule(
      ec2.Peer.securityGroupId(AppSecGroup.securityGroupId),
      ec2.Port.tcp(3306),
      "allow MYSQL"
    );

  

    const subnetgroup = new rds.SubnetGroup(this, "subnetgroup", {
      vpc: threeTierVpc,

      subnetGroupName: "three-tier-sb-subnet-group",
      description: "subnetgroup",
      vpcSubnets: {
        availabilityZones: ["us-east-2a", "us-east-2b"],
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
    });

    const AuroraSecret = new rds.DatabaseSecret(this, "AuroraSecret", {
      username: "admin",
      secretName: "AuroraSecret",
    });

    const rdsCluster = new rds.DatabaseCluster(this, "rdsCluster", {
      engine: rds.DatabaseClusterEngine.auroraMysql({
        version: rds.AuroraMysqlEngineVersion.VER_3_05_2,
      }),
      credentials: rds.Credentials.fromSecret(AuroraSecret),
      subnetGroup: subnetgroup,
      securityGroups: [DBSG],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      vpc: threeTierVpc,
      defaultDatabaseName: "webappdb",
      // instances: 1,
      readers: [
        rds.ClusterInstance.provisioned("reader1"),
      ],
      writer: rds.ClusterInstance.provisioned("writer1"),
    });






    new cdk.CfnOutput(this, "WebALB", {
      value: WebAppALB.loadBalancerDnsName,
    });
  }
}
