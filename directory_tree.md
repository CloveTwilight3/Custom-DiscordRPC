# Project Structure

```
discord-rpc-status/
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   └── bug_report.md
│   └── workflows/
│       └── build.yml
├── windows/
│   ├── src/
│   │   └── index.ts
│   ├── config.sample.json
│   ├── package.json
│   ├── tsconfig.json
│   └── start-discord-rpc.bat
├── .gitignore
├── CONTRIBUTING.md
├── LICENSE
└── README.md
```

## Directory Structure Explanation

- **Root Directory**: Contains project-wide files like README, LICENSE, etc.
- **`.github/`**: Contains GitHub-specific files for workflows and issue templates
- **`windows/`**: Contains the Windows-specific implementation
  - **`src/`**: Source code for the Windows version
  - **`config.sample.json`**: Template configuration file
  - **`package.json`**: Dependencies and scripts for the Windows version
  - **`tsconfig.json`**: TypeScript configuration for the Windows version
  - **`start-discord-rpc.bat`**: Windows batch script for easy startup