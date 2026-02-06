#!/bin/bash
# Finny AlgoClash - Digital Ocean Deployment Script
# Usage: ./deploy.sh [domain]

set -e

DOMAIN=${1:-""}
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}"
echo "╔═══════════════════════════════════════════════════════════╗"
echo "║        Finny AlgoClash - Deployment Script                ║"
echo "╚═══════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# Check if running on a fresh server
if ! command -v docker &> /dev/null; then
    echo -e "${YELLOW}Installing Docker...${NC}"
    curl -fsSL https://get.docker.com -o get-docker.sh
    sudo sh get-docker.sh
    sudo usermod -aG docker $USER
    rm get-docker.sh
    echo "Docker installed. Please log out and back in, then run this script again."
    exit 0
fi

if ! command -v docker-compose &> /dev/null; then
    echo -e "${YELLOW}Installing Docker Compose...${NC}"
    sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
    sudo chmod +x /usr/local/bin/docker-compose
fi

# Create directories
mkdir -p certbot/conf certbot/www strategies

if [ -z "$DOMAIN" ]; then
    # Development mode - no SSL
    echo -e "${YELLOW}Starting in development mode (no SSL)...${NC}"
    echo "Access at: http://$(curl -s ifconfig.me):8000"
    docker-compose up -d algoclash
else
    # Production mode with SSL
    echo -e "${YELLOW}Setting up SSL for ${DOMAIN}...${NC}"

    # Update nginx config with domain
    sed -i "s/your-domain.com/${DOMAIN}/g" nginx.conf

    # Get initial certificate
    docker-compose run --rm certbot certonly --webroot \
        --webroot-path=/var/www/certbot \
        --email admin@${DOMAIN} \
        --agree-tos \
        --no-eff-email \
        -d ${DOMAIN}

    # Start all services
    docker-compose --profile production up -d

    echo -e "${GREEN}AlgoClash deployed at: https://${DOMAIN}${NC}"
fi

echo ""
echo -e "${GREEN}Deployment complete!${NC}"
echo ""
echo "Useful commands:"
echo "  docker-compose logs -f          # View logs"
echo "  docker-compose restart algoclash # Restart simulator"
echo "  docker-compose down              # Stop all services"
echo "  docker-compose up -d             # Start services"
