# Discord Rich Presence Activity Tracker

![GitHub Workflow Status](https://img.shields.io/github/workflow/status/clovetwilight3/Custom-DiscordRPC/Build%20and%20Test)
![License](https://img.shields.io/github/license/clovetwilight3/Custom-DiscordRPC)
![GitHub last commit](https://img.shields.io/github/last-commit/clovetwilight3/Custom-DiscordRPC)

This application automatically updates your Discord status with your current PC activity in real-time, showing what application you're using, how long you've been using it, and system metrics.

## 📂 Project Structure

This repository is organized by platform:

- **`/windows`**: Windows implementation of the Discord RPC Status Tracker
- Additional platforms may be added in the future

## 🚀 Getting Started

### Windows Installation

Navigate to the Windows directory for setup instructions:

```bash
cd windows
```

Then follow the instructions in the Windows-specific README or run:

```bash
npm install
# Create config.json from config.sample.json
npm start
```

Alternatively, you can run the included batch file:

```bash
windows/start-discord-rpc.bat
```

## ✨ Features

- **Live Status Updates**: Updates your Discord status every 10 seconds
- **Application Detection**: Automatically identifies your favorite applications
- **Accurate Timers**: Shows how long you've been using each application
- **System Stats**: Displays CPU and RAM usage
- **Daily Stats**: Tracks total time spent on different activities
- **Customizable**: Easy to add your own applications and settings

## 📋 Prerequisites

- Windows Operating System
- [Node.js](https://nodejs.org/) (v16 or higher)
- [Discord Desktop Client](https://discord.com/)
- A [Discord Developer Account](https://discord.com/developers/applications)

## 🤝 Contributing

Please see [CONTRIBUTING.md](CONTRIBUTING.md) for details on how to contribute to this project.

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.