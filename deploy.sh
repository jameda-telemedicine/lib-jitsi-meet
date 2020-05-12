#!/bin/bash

npm install
echo "Start Deployment"
echo "Deploy local"
#cp lib-jitsi-meet.min.* ../../jameda-telemedicine/jitsi-meet/libs/
cp lib-jitsi-meet.min.* ~/.jitsi-meet-cfg/web/jitsi-meet/libs/
echo "Deploy devops"
cp lib-jitsi-meet.min.* ~/workspace/patientus/devops/roles/projects/jitsi-meet/files/