# Deploying AlgoClash to Digital Ocean

This guide walks you through deploying the AlgoClash simulator to a Digital Ocean droplet.

## Prerequisites

- Digital Ocean account (with GitHub Education credits)
- A domain name (optional, but recommended for SSL)

## Step 1: Create a Droplet

1. Go to [Digital Ocean](https://cloud.digitalocean.com/)
2. Click **Create** → **Droplets**
3. Choose:
   - **Image**: Ubuntu 22.04 LTS
   - **Plan**: Basic, $6/mo (1GB RAM) or $12/mo (2GB RAM recommended)
   - **Datacenter**: Choose closest to your users
   - **Authentication**: SSH Key (recommended) or Password
4. Click **Create Droplet**
5. Note the IP address (e.g., `167.99.123.45`)

## Step 2: Connect to Your Droplet

```bash
ssh root@YOUR_DROPLET_IP
```

## Step 3: Clone and Deploy

```bash
# Clone the repository
git clone https://github.com/YOUR_USERNAME/finny.git
cd finny

# Run the deployment script
./deploy.sh
```

This will:
- Install Docker if not present
- Build the AlgoClash container
- Start the simulator on port 8000

## Step 4: Test It

From your local machine:

```bash
curl http://YOUR_DROPLET_IP:8000/health
```

You should see:
```json
{"status": "healthy", "arena_running": false, ...}
```

## Step 5: Configure Your Finny CLI

On your local machine, set the environment variable to point to your server:

```bash
# Add to your ~/.bashrc or ~/.zshrc
export FINNY_SIMULATOR_URL=http://YOUR_DROPLET_IP:8000

# Or for HTTPS with domain
export FINNY_SIMULATOR_URL=https://algoclash.yourdomain.com
```

Then reload your shell:
```bash
source ~/.zshrc  # or ~/.bashrc
```

Now when you use the finny TUI and deploy strategies, they'll go to your cloud server.

---

## Optional: Add SSL with a Domain

If you have a domain name:

### 1. Point DNS to Your Droplet

Add an A record:
- **Type**: A
- **Name**: `algoclash` (or `@` for root)
- **Value**: Your droplet IP
- **TTL**: 300

### 2. Deploy with SSL

```bash
./deploy.sh algoclash.yourdomain.com
```

This will:
- Set up nginx as a reverse proxy
- Obtain SSL certificate from Let's Encrypt
- Enable HTTPS

---

## Useful Commands

```bash
# View logs
docker-compose logs -f algoclash

# Restart the simulator
docker-compose restart algoclash

# Stop everything
docker-compose down

# Update and redeploy
git pull
docker-compose build
docker-compose up -d
```

## Architecture

```
Internet
    │
    ▼
┌─────────────────────────────────────────┐
│         Digital Ocean Droplet           │
│                                         │
│  ┌─────────┐      ┌─────────────────┐   │
│  │  nginx  │─────▶│ AlgoClash:8000  │   │
│  │ :80/443 │      │                 │   │
│  └─────────┘      │  ┌───────────┐  │   │
│                   │  │ SQLite DB │  │   │
│                   │  └───────────┘  │   │
│                   │  ┌───────────┐  │   │
│                   │  │strategies/│  │   │
│                   │  └───────────┘  │   │
│                   └─────────────────┘   │
└─────────────────────────────────────────┘
```

## Costs

With GitHub Education credits ($100):

| Component | Monthly Cost |
|-----------|--------------|
| Droplet (1GB) | $6 |
| Domain (.me free) | $0 |
| SSL (Let's Encrypt) | $0 |
| **Total** | **$6/mo** |

Your $100 credits = ~16 months of free hosting!

## Troubleshooting

### Port 8000 not accessible
```bash
# Check if firewall is blocking
sudo ufw allow 8000
sudo ufw allow 80
sudo ufw allow 443
```

### Container won't start
```bash
# Check logs
docker-compose logs algoclash

# Rebuild from scratch
docker-compose down
docker-compose build --no-cache
docker-compose up -d
```

### Database issues
```bash
# Database is stored in a Docker volume
docker volume ls

# To reset (WARNING: deletes all data)
docker-compose down -v
docker-compose up -d
```
