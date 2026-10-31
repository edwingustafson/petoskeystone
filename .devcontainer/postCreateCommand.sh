#!/usr/bin/bash

sudo apt-get -y update && sudo apt upgrade -y
sudo apt-get -y install build-essential

curl -fsSL https://claude.ai/install.sh | bash
