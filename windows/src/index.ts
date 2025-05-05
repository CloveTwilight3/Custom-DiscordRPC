import { Client } from 'discord-rpc';
import * as os from 'os';
import * as fs from 'fs';
import * as childProcess from 'child_process';

// Config options
interface AppConfig {
  defaultClientId: string;
  updateInterval: number;
  enableDetailedStats: boolean;
  enableSystemInfo: boolean;
  idleTimeout: number;
  applications: {
    [key: string]: {
      clientId: string;
      processNames: string[];
    }
  };
}

// Default configuration (will be overridden by config.json)
const defaultConfig: AppConfig = {
  defaultClientId: '', // Will be filled from config.json
  updateInterval: 10000,
  enableDetailedStats: true,
  enableSystemInfo: true,
  idleTimeout: 300000,
  applications: {
    games: { clientId: '', processNames: [] },
    web: { clientId: '', processNames: [] },
    messaging: { clientId: '', processNames: [] },
    music: { clientId: '', processNames: [] },
    code: { clientId: '', processNames: [] },
    creative: { clientId: '', processNames: [] }
  }
};

// Try to load config from file, fall back to default
let config: AppConfig;
try {
  if (fs.existsSync('./config.json')) {
    const configFile = fs.readFileSync('./config.json', 'utf8');
    config = { ...defaultConfig, ...JSON.parse(configFile) };
    console.log('Loaded configuration from config.json');
  } else {
    console.error('config.json not found! Please create it first.');
    process.exit(1);
  }
} catch (error) {
  console.error('Error loading config:', error);
  process.exit(1);
}

// Read priority apps from config
const priorityApps = (config as any).priorityApps || [];
const customApps = (config as any).customApps || [];

// Keep track of the current client
let currentClientId: string = config.defaultClientId;
let client = new Client({ transport: 'ipc' });
let clientConnected = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

// Interface for activity data
interface ActivityData {
  details: string;
  state: string;
  largeImageKey: string;
  largeImageText: string;
  smallImageKey?: string;
  smallImageText?: string;
  startTimestamp?: number;
  endTimestamp?: number;
  buttons?: { label: string; url: string }[];
}

// Activity tracking class
class ActivityTracker {
  private lastActivity: string = '';
  private lastProcessName: string = '';
  private lastAppType: string = '';
  private startTime: number = Date.now();
  private activityTimers: Map<string, number> = new Map();
  private dailyActivityStats: Map<string, number> = new Map();
  
  // Get current active application
  public async getCurrentActivity(): Promise<{activity: ActivityData, appType: string, processName: string}> {
    try {
      // Use PowerShell to get the foreground window details
      const foregroundWindowScript = `
      Add-Type @"
        using System;
        using System.Runtime.InteropServices;
        using System.Text;
        public class ForegroundWindow {
            [DllImport("user32.dll")]
            public static extern IntPtr GetForegroundWindow();

            [DllImport("user32.dll")]
            public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

            [DllImport("user32.dll", SetLastError=true)]
            public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
        }
"@

      $hwnd = [ForegroundWindow]::GetForegroundWindow()
      $processId = 0
      [ForegroundWindow]::GetWindowThreadProcessId($hwnd, [ref]$processId) | Out-Null

      $process = Get-Process -Id $processId -ErrorAction SilentlyContinue

      $windowText = New-Object System.Text.StringBuilder 256
      [ForegroundWindow]::GetWindowText($hwnd, $windowText, 256) | Out-Null

      if ($process) {
          $output = @{
              MainWindowTitle = $windowText.ToString()
              ProcessName = $process.ProcessName
          } | ConvertTo-Json
          Write-Output $output
      } else {
          $output = @{
              MainWindowTitle = $windowText.ToString()
              ProcessName = "Unknown"
          } | ConvertTo-Json
          Write-Output $output
      }
      `;

      // Save the script to a temporary file
      const scriptPath = './temp_window_script.ps1';
      fs.writeFileSync(scriptPath, foregroundWindowScript);

      // Execute the script to get the actual foreground window
      const activeWindowCommand = `powershell.exe -File "${scriptPath}"`;
      
      let result;
      try {
        result = childProcess.execSync(activeWindowCommand).toString().trim();
        
        // Clean up the temporary script file
        try {
          fs.unlinkSync(scriptPath);
        } catch (e) {
          console.error("Error removing temporary script file:", e);
        }
      } catch (e) {
        console.error('Error running PowerShell script for active window:', e);
        
        // Try to clean up even if there was an error
        try {
          fs.unlinkSync(scriptPath);
        } catch (cleanupError) {
          console.error("Error removing temporary script file:", cleanupError);
        }
        
        result = '{"MainWindowTitle":"Unknown Window","ProcessName":"Unknown"}';
      }
      
      // Parse the result
      let activeWindow;
      try {
        activeWindow = JSON.parse(result);
      } catch (e) {
        console.log("JSON parsing failed, using raw result");
        activeWindow = {
          MainWindowTitle: "Unknown Window",
          ProcessName: "Unknown"
        };
      }
      
      const windowTitle = activeWindow.MainWindowTitle || "Unknown";
      const processName = activeWindow.ProcessName || "Unknown";
      
      console.log(`Active window detected: "${windowTitle}" - Process: ${processName}`);
      
      // Determine which application category this belongs to
      let appType = 'default';
      for (const [type, app] of Object.entries(config.applications)) {
        if (app.processNames.some(p => 
          processName.toLowerCase().includes(p.toLowerCase()) || 
          windowTitle.toLowerCase().includes(p.toLowerCase())
        )) {
          appType = type;
          break;
        }
      }
      
      // Basic activity detection logic
      let activityType = 'app';
      let largeImageKey = 'windows';
      let details = `Using ${processName}`;
      let state = windowTitle.length > 2 ? windowTitle : 'Idle';
      
      // Try to match priority apps first (user's commonly used apps)
      let matchedApp = false;
      
      // First check priority apps (user's common apps)
      for (const app of priorityApps) {
        if (processName.toLowerCase().includes(app.processName.toLowerCase()) || 
            windowTitle.toLowerCase().includes(app.processName.toLowerCase())) {
          activityType = app.type;
          largeImageKey = app.icon;
          details = app.details;
          state = windowTitle;
          matchedApp = true;
          
          // Special handling for specific apps
          if (app.processName.toLowerCase().includes('spotify')) {
            // Try to extract song name from Spotify window title
            const songMatch = windowTitle.match(/(.+?) - (.+?) - Spotify/);
            if (songMatch) {
              const song = songMatch[1].trim();
              const artist = songMatch[2].trim();
              state = `${song} by ${artist}`;
              
              if (song && artist) {
                details = `Listening to Music`;
              }
            } else if (windowTitle.trim() === 'Spotify' || windowTitle.includes('Spotify Premium')) {
              state = 'Browsing Music';
              details = 'Using Spotify';
            }
          } else if (app.processName.toLowerCase().includes('discord')) {
            // For Discord, try to show channel or DM
            if (windowTitle.includes(' - ')) {
              const parts = windowTitle.split(' - ');
              if (parts.length >= 3) {
                state = `In #${parts[0]} on ${parts[1]}`;
              } else if (parts.length >= 2) {
                state = `Chatting in ${parts[0]}`;
              }
            } else if (windowTitle.toLowerCase().includes('direct')) {
              state = 'In Direct Messages';
            }
          } else if (app.processName.toLowerCase().includes('valorant') || 
                     processName.toLowerCase() === 'VALORANT-Win64-Shipping') {
            // Special handling for VALORANT
            details = 'Playing VALORANT';
            if (windowTitle.toLowerCase().includes('lobby')) {
              state = 'In Lobby';
            } else if (windowTitle.toLowerCase().includes('match')) {
              state = 'In a Match';
            } else {
              state = 'In Game';
            }
          } else if (app.processName.toLowerCase().includes('chrome')) {
            // For Chrome, extract the website
            const chromeMatch = windowTitle.match(/(.+) - ([^-]+) - Google Chrome$/);
            if (chromeMatch) {
              state = `On ${chromeMatch[2].trim()}`;
            } else {
              const simpleMatch = windowTitle.match(/(.+) - Google Chrome$/);
              if (simpleMatch) {
                state = `On ${simpleMatch[1].trim()}`;
              }
            }
            
            // Special cases for common websites
            if (windowTitle.toLowerCase().includes('youtube')) {
              details = 'Watching YouTube';
              
              // Try to extract video title
              const ytMatch = windowTitle.match(/(.+) - YouTube/);
              if (ytMatch) {
                state = `Watching: ${ytMatch[1].trim()}`;
              }
            } else if (windowTitle.toLowerCase().includes('twitch')) {
              details = 'Watching Twitch';
            }
          } else if (app.processName.toLowerCase() === 'code') {
            // For VS Code, extract file type
            const fileMatch = windowTitle.match(/\.([^.]+) -/);
            if (fileMatch) {
              const extension = fileMatch[1].toLowerCase();
              const langMap: Record<string, string> = {
                'js': 'JavaScript',
                'ts': 'TypeScript',
                'py': 'Python',
                'java': 'Java',
                'cpp': 'C++',
                'cs': 'C#',
                'html': 'HTML',
                'css': 'CSS',
                'php': 'PHP'
              };
              
              const language = langMap[extension] || extension;
              state = `Coding in ${language}`;
            }
          }
          
          break;
        }
      }
      
      // If no priority app was matched, try custom apps
      if (!matchedApp) {
        for (const app of customApps) {
          if (processName.toLowerCase().includes(app.processName.toLowerCase()) || 
              windowTitle.toLowerCase().includes(app.processName.toLowerCase())) {
            activityType = app.type;
            largeImageKey = app.icon;
            details = app.details;
            state = windowTitle;
            matchedApp = true;
            break;
          }
        }
      }

      // Game-specific detection logic
      if (processName === 'VALORANT-Win64-Shipping') {
        appType = 'games';
        activityType = 'games';
        largeImageKey = 'valorant';
        details = 'Playing VALORANT';
        
        if (windowTitle.toLowerCase().includes('lobby')) {
          state = 'In Lobby';
        } else {
          state = 'In Game';
        }
        matchedApp = true;
      }
      
      // If no app matched, use a generic default
      if (!matchedApp) {
        largeImageKey = 'windows';
      }
      
      // Update app type if we have a specific match but no app type
      if (appType === 'default' && activityType !== 'app') {
        // Map the activity type to an app type
        const activityToAppType: Record<string, string> = {
          'gaming': 'games',
          'music': 'music',
          'coding': 'code',
          'browsing': 'web',
          'chat': 'messaging',
          'design': 'creative',
          'streaming': 'creative'
        };
        
        if (activityToAppType[activityType]) {
          appType = activityToAppType[activityType];
        }
      }
      
      // Reset the start time if the application changed
      if (processName !== this.lastProcessName || appType !== this.lastAppType) {
        console.log(`Application changed from ${this.lastProcessName} to ${processName}`);
        console.log(`App type changed from ${this.lastAppType} to ${appType}`);
        this.startTime = Date.now();
        this.lastProcessName = processName;
        this.lastAppType = appType;
      }
      
      // Only reset the activity type if it changed
      if (activityType !== this.lastActivity) {
        this.lastActivity = activityType;
      }
      
      // Calculate duration for current activity
      const activityDuration = Date.now() - this.startTime;
      const formattedDuration = this.formatDuration(activityDuration);
      
      // Track activity timing
      this.trackActivityTime(activityType);
      
      // Format state based on settings
      let formattedState = state;
      if (config.enableDetailedStats) {
        formattedState = `${state.substring(0, 60)} | ${formattedDuration}`;
        
        // Add system info if enabled
        if (config.enableSystemInfo) {
          const cpuUsage = this.getCpuUsage();
          const memoryUsage = this.getMemoryUsage();
          formattedState += ` | CPU: ${cpuUsage}%, RAM: ${memoryUsage}%`;
        }
      }
      
      // Create activity data
      const activity: ActivityData = {
        details: details.substring(0, 128),
        state: formattedState.substring(0, 128),
        largeImageKey,
        largeImageText: `${activityType.charAt(0).toUpperCase() + activityType.slice(1)} for ${formattedDuration}`,
        smallImageKey: 'info',
        smallImageText: `${os.hostname()} | Today: ${this.formatDuration((this.dailyActivityStats.get(activityType) || 0) * 1000)}`,
        startTimestamp: this.startTime
      };
      
      return {
        activity,
        appType,
        processName
      };
    } catch (error) {
      console.error('Error detecting activity:', error);
      
      // Return default activity on error
      return {
        activity: {
          details: 'Online',
          state: 'Using Windows',
          largeImageKey: 'windows',
          largeImageText: `Windows ${os.release()}`,
          startTimestamp: this.startTime
        },
        appType: 'default',
        processName: 'explorer'
      };
    }
  }
  
  // Helper functions
  private getCpuUsage(): number {
    const cpus = os.cpus();
    let totalIdle = 0;
    let totalTick = 0;
    
    cpus.forEach(cpu => {
      for (const type in cpu.times) {
        totalTick += cpu.times[type as keyof typeof cpu.times];
      }
      totalIdle += cpu.times.idle;
    });
    
    const usage = 100 - Math.round(totalIdle / totalTick * 100);
    return usage;
  }
  
  private getMemoryUsage(): number {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const memUsage = Math.round((usedMem / totalMem) * 100);
    return memUsage;
  }
  
  private formatDuration(milliseconds: number): string {
    const seconds = Math.floor(milliseconds / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    
    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }
  
  private trackActivityTime(activityType: string): void {
    const now = Date.now();
    
    // Update time for current activity
    if (!this.activityTimers.has(activityType)) {
      this.activityTimers.set(activityType, now);
    }
    
    // Update daily stats
    const dailyTime = this.dailyActivityStats.get(activityType) || 0;
    this.dailyActivityStats.set(activityType, dailyTime + 10); // Add 10 seconds (update interval)
  }
}

// Main application class
class DiscordRPCApp {
  private activityTracker: ActivityTracker;
  private updateInterval: NodeJS.Timeout | null = null;
  private switchTimeout: NodeJS.Timeout | null = null;
  private lastSwitchTime: number = 0;
  private isReconnecting: boolean = false;
  
  constructor() {
    this.activityTracker = new ActivityTracker();
    this.setupClientEventHandlers();
  }
  
  // Set up event handlers for the RPC client
  private setupClientEventHandlers(): void {
    client.on('ready', () => {
      console.log(`Discord RPC connected with client ID: ${currentClientId}`);
      clientConnected = true;
      reconnectAttempts = 0;
      this.startActivityTracking();
    });
    
    client.on('error', (error) => {
      console.error('Discord RPC error:', error);
      clientConnected = false;
      if (!this.isReconnecting) {
        this.reconnect();
      }
    });
    
    client.on('disconnected', () => {
      console.log('Discord RPC disconnected');
      clientConnected = false;
      if (!this.isReconnecting) {
        this.reconnect();
      }
    });
  }
  
  // Start the Discord RPC application
  public async start(): Promise<void> {
    try {
      console.log('Starting Discord RPC application...');
      console.log(`Default Client ID: ${config.defaultClientId}`);
      
      // Print available application types
      console.log('Available application types:');
      for (const [type, app] of Object.entries(config.applications)) {
        console.log(`- ${type}: ${app.clientId}`);
      }
      
      // Connect with the default client ID
      await client.login({ clientId: config.defaultClientId });
      currentClientId = config.defaultClientId;
    } catch (error) {
      console.error('Failed to connect to Discord:', error);
      this.reconnect();
    }
  }
  
  // Reconnect logic with exponential backoff
  private reconnect(): void {
    if (this.isReconnecting) return;
    
    this.isReconnecting = true;
    reconnectAttempts++;
    
    // Calculate backoff time (exponential backoff with max of 2 minutes)
    const backoffTime = Math.min(15000 * Math.pow(1.5, reconnectAttempts - 1), 120000);
    
    console.log(`Attempting to reconnect in ${backoffTime/1000} seconds... (Attempt ${reconnectAttempts})`);
    
    setTimeout(() => {
      this.isReconnecting = false;
      this.start();
    }, backoffTime);
  }
  
  // Function to switch to a different Discord application with debouncing
  private async switchClient(newClientId: string): Promise<boolean> {
    if (newClientId === currentClientId && clientConnected) {
      return true; // Already using the correct client
    }
    
    // Check if we're switching too frequently
    const now = Date.now();
    if (now - this.lastSwitchTime < 15000) { // Don't switch more than once every 15 seconds
      console.log(`Delaying app switch - last switch was ${(now - this.lastSwitchTime) / 1000} seconds ago`);
      return false;
    }
    
    // Clear any pending switch timeout
    if (this.switchTimeout) {
      clearTimeout(this.switchTimeout);
    }
    
    // Debounce the switch (wait 3 seconds to avoid too frequent switching)
    return new Promise((resolve) => {
      this.switchTimeout = setTimeout(async () => {
        console.log(`Switching from ${currentClientId} to ${newClientId}`);
        
        try {
          // Destroy the current client
          if (clientConnected) {
            try {
              await client.destroy();
            } catch (e) {
              console.error('Error destroying client:', e);
            }
            clientConnected = false;
          }
          
          // Create a new client
          client = new Client({ transport: 'ipc' });
          this.setupClientEventHandlers();
          
          // Connect with the new client ID
          await client.login({ clientId: newClientId });
          currentClientId = newClientId;
          this.lastSwitchTime = Date.now();
          
          resolve(true);
        } catch (error) {
          console.error('Error switching clients:', error);
          resolve(false);
        }
      }, 3000);
    });
  }
  
  // Start tracking and updating activity
  private startActivityTracking(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
    }
    
    // Update activity based on config interval
    this.updateInterval = setInterval(async () => {
      try {
        // Get current activity and appropriate client
        const { activity, appType, processName } = await this.activityTracker.getCurrentActivity();
        
        // Determine which client ID to use
        let clientId = config.defaultClientId;
        if (config.applications[appType]) {
          clientId = config.applications[appType].clientId;
        }
        
        // Switch client if necessary
        if (clientId !== currentClientId) {
          console.log(`Detected activity change to ${appType}. Preparing to switch client...`);
          this.switchClient(clientId).then((switched) => {
            if (!switched) {
              console.log('Delaying client switch to avoid rate limits');
            }
          });
        }
        
        // Set the activity if we're connected
        if (clientConnected) {
          client.setActivity(activity);
          console.log(`Activity updated for ${appType}:`, activity.details, activity.state);
        } else {
          console.log('Client not connected, waiting for reconnect...');
        }
      } catch (error) {
        console.error('Error updating activity:', error);
      }
    }, config.updateInterval);
    
    console.log('Activity tracking started.');
  }
  
  // Stop the application
  public stop(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
    
    if (this.switchTimeout) {
      clearTimeout(this.switchTimeout);
      this.switchTimeout = null;
    }
    
    client.destroy();
    console.log('Discord RPC application stopped.');
  }
}

// Create and start the application
const app = new DiscordRPCApp();
app.start();

// Handle process signals
process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down...');
  app.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down...');
  app.stop();
  process.exit(0);
});

console.log('Discord Multi-App RPC running. Press Ctrl+C to exit.');