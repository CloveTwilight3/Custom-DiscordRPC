import { Client } from 'discord-rpc';
import * as os from 'os';
import * as fs from 'fs';
import * as childProcess from 'child_process';

// Config options
interface AppConfig {
  clientId: string;
  updateInterval: number; // in ms
  enableDetailedStats: boolean;
  enableSystemInfo: boolean;
  idleTimeout: number; // in ms
}

// Default configuration - Edit these values or create a config.json file
const defaultConfig: AppConfig = {
  clientId: 'YOUR_CLIENT_ID_HERE', // You'll need to create one at https://discord.com/developers/applications
  updateInterval: 10000, // 10 seconds
  enableDetailedStats: true,
  enableSystemInfo: true,
  idleTimeout: 300000 // 5 minutes
};

// Try to load config from file, fall back to default
let config: AppConfig;
try {
  if (fs.existsSync('./config.json')) {
    const configFile = fs.readFileSync('./config.json', 'utf8');
    config = { ...defaultConfig, ...JSON.parse(configFile) };
    console.log('Loaded configuration from config.json');
  } else {
    config = defaultConfig;
    console.log('Using default configuration');
    // Create a default config file for future use
    fs.writeFileSync('./config.json', JSON.stringify(defaultConfig, null, 2));
    console.log('Created default config.json file');
  }
} catch (error) {
  console.error('Error loading config, using defaults:', error);
  config = defaultConfig;
}

// Read priority apps from config
const priorityApps = (config as any).priorityApps || [];
const customApps = (config as any).customApps || [];

// Initialize Discord RPC client
const client = new Client({ transport: 'ipc' });

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
  private lastProcessName: string = ''; // Track the last process name to detect app changes
  private startTime: number = Date.now();
  private activityTimers: Map<string, number> = new Map();
  private dailyActivityStats: Map<string, number> = new Map();
  
  // Get current active application
  public async getCurrentActivity(): Promise<ActivityData> {
    try {
      // DEBUGGING: List all windows
      const listAllWindowsCommand = 'powershell.exe "Get-Process | Where-Object {$_.MainWindowTitle -ne \'\'} | Select-Object MainWindowTitle, ProcessName | ConvertTo-Json"';
      let allWindowsResult;
      try {
        allWindowsResult = childProcess.execSync(listAllWindowsCommand).toString();
      } catch (e) {
        console.error('Error running PowerShell command for window listing:', e);
        allWindowsResult = '[]';
      }

      // Parse all windows
      let allWindows;
      try {
        allWindows = JSON.parse(allWindowsResult);
        if (!Array.isArray(allWindows)) {
          allWindows = [allWindows];
        }
        
        // Log all detected windows for debugging
        console.log('\nAll detected windows:');
        allWindows.forEach((window, index) => {
          console.log(`Window ${index + 1}: "${window.MainWindowTitle}" - Process: ${window.ProcessName}`);
        });
        console.log('-----------------------------------');
      } catch (e) {
        console.error('Error parsing windows list:', e);
      }

      // =========== IMPROVED ACTIVE WINDOW DETECTION ===========
      // This uses a PowerShell script that leverages the Win32 API to get the actual foreground window
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
        console.log("Raw active window result:", result);
        
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
      
      console.log("Active window detected:", windowTitle, "Process:", processName);
      
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
            // Try to extract song name from Spotify
            // Spotify window title format: "Song Name - Artist - Spotify"
            const songMatch = windowTitle.match(/(.+?) - (.+?) - Spotify/);
            if (songMatch) {
              const song = songMatch[1].trim();
              const artist = songMatch[2].trim();
              state = `${song} by ${artist}`;
              
              // If we have a song, update the details too
              if (song && artist) {
                details = `Listening to Music`;
              }
            } else {
              // Alternative pattern: sometimes it's just "Spotify"
              // or "Spotify Premium" when not playing
              if (windowTitle.trim() === 'Spotify' || 
                  windowTitle.includes('Spotify Premium')) {
                state = 'Browsing Music';
                details = 'Using Spotify';
              }
            }
          } else if (app.processName.toLowerCase().includes('discord')) {
            // For Discord, try to show channel or DM
            if (windowTitle.includes(' - ')) {
              const parts = windowTitle.split(' - ');
              if (parts.length >= 2) {
                // Most likely format is "channel - server - Discord"
                if (parts.length >= 3) {
                  state = `In #${parts[0]} on ${parts[1]}`;
                } else {
                  state = `Chatting in ${parts[0]}`;
                }
              }
            } else if (windowTitle.toLowerCase().includes('direct')) {
              state = 'In Direct Messages';
            }
          } else if (app.processName.toLowerCase().includes('steam')) {
            // For Steam, try to extract the game name
            if (windowTitle.includes(' - ')) {
              const parts = windowTitle.split(' - ');
              if (parts.length >= 2 && parts[parts.length - 1].toLowerCase().includes('steam')) {
                // Format is often "Game Name - Steam"
                state = `Playing ${parts[0]}`;
                details = `Gaming on Steam`;
              }
            } else if (windowTitle.toLowerCase().includes('store')) {
              state = 'Browsing the Store';
            } else if (windowTitle.toLowerCase().includes('library')) {
              state = 'Browsing Library';
            } else if (windowTitle.toLowerCase().includes('community')) {
              state = 'Browsing Community';
            } else if (windowTitle.toLowerCase() === 'steam') {
              state = 'In Steam Client';
            }
          } else if (app.processName.toLowerCase().includes('chrome')) {
            // For Chrome, extract the website
            // Chrome title format is typically "Page Title - Website - Google Chrome"
            const chromeMatch = windowTitle.match(/(.+) - ([^-]+) - Google Chrome$/);
            if (chromeMatch) {
              state = `On ${chromeMatch[2].trim()}`;
            } else {
              // Sometimes it's just "Website - Google Chrome"
              const simpleMatch = windowTitle.match(/(.+) - Google Chrome$/);
              if (simpleMatch) {
                state = `On ${simpleMatch[1].trim()}`;
              }
            }
            
            // Special cases for common websites
            if (windowTitle.toLowerCase().includes('youtube')) {
              details = 'Watching YouTube';
              largeImageKey = 'youtube';
              
              // Try to extract video title
              const ytMatch = windowTitle.match(/(.+) - YouTube/);
              if (ytMatch) {
                state = `Watching: ${ytMatch[1].trim()}`;
              }
            } else if (windowTitle.toLowerCase().includes('twitch')) {
              details = 'Watching Twitch';
              largeImageKey = 'twitch';
            } else if (windowTitle.toLowerCase().includes('github')) {
              details = 'Working on GitHub';
              largeImageKey = 'github';
            }
          } else if (app.processName.toLowerCase().includes('fortnite')) {
            state = 'Battle Royale';
            if (windowTitle.toLowerCase().includes('lobby')) {
              state = 'In Lobby';
            } else if (windowTitle.toLowerCase().includes('battle')) {
              state = 'In Battle';
            }
          } else if (app.processName.toLowerCase().includes('minecraft') || 
                      app.processName.toLowerCase().includes('prism')) {
            if (windowTitle.toLowerCase().includes('server')) {
              const serverMatch = windowTitle.match(/server:?\s*([^-]+)/i);
              if (serverMatch) {
                state = `On server: ${serverMatch[1].trim()}`;
              }
            } else {
              state = 'Playing Minecraft';
            }
          } else if (app.processName.toLowerCase().includes('code')) {
            // For VS Code, extract file type
            const fileMatch = windowTitle.match(/\.([^.]+)$/);
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
            
            // Special handling for ApplicationFrameHost
            if (processName.toLowerCase() === 'applicationframehost') {
              // For ApplicationFrameHost, we can extract the actual app name from the window title
              // The window title is usually just the app name for modern Windows apps
              const appName = windowTitle.split(' - ')[0] || windowTitle;
              details = `Using ${appName}`;
            } else {
              details = app.details;
            }
            
            state = windowTitle;
            matchedApp = true;
            break;
          }
        }
      }

      // Common applications mapping for process name detection
      if (!matchedApp) {
        const appMap: Record<string, {type: string, icon: string, details: string}> = {
          // Browsers - Use chrome icon for all browsers
          'chrome': {type: 'browsing', icon: 'chrome', details: 'Browsing with Chrome'},
          'firefox': {type: 'browsing', icon: 'windows', details: 'Browsing with Firefox'},
          'edge': {type: 'browsing', icon: 'windows', details: 'Browsing with Edge'},
          'brave': {type: 'browsing', icon: 'windows', details: 'Browsing with Brave'},
          'opera': {type: 'browsing', icon: 'windows', details: 'Browsing with Opera'},
          
          // Development - Use vscode icon for coding
          'code': {type: 'coding', icon: 'vscode', details: 'Coding in VS Code'},
          'visual studio': {type: 'coding', icon: 'vscode', details: 'Developing in Visual Studio'},
          'intellij': {type: 'coding', icon: 'vscode', details: 'Coding in IntelliJ'},
          'pycharm': {type: 'coding', icon: 'vscode', details: 'Coding in PyCharm'},
          'android studio': {type: 'coding', icon: 'vscode', details: 'Android Development'},
          'sublime': {type: 'coding', icon: 'vscode', details: 'Coding in Sublime'},
          'notepad++': {type: 'coding', icon: 'vscode', details: 'Editing in Notepad++'},
          
          // Productivity - Use windows icon for these
          'word': {type: 'writing', icon: 'windows', details: 'Writing in Word'},
          'excel': {type: 'spreadsheet', icon: 'windows', details: 'Working in Excel'},
          'powerpoint': {type: 'presentation', icon: 'windows', details: 'Creating a Presentation'},
          'outlook': {type: 'email', icon: 'windows', details: 'Checking Email'},
          'onenote': {type: 'notes', icon: 'windows', details: 'Taking Notes'},
          'teams': {type: 'meeting', icon: 'windows', details: 'In a Meeting'},
          'slack': {type: 'chat', icon: 'windows', details: 'Chatting on Slack'},
          'discord': {type: 'chat', icon: 'discord', details: 'Chatting on Discord'},
          'zoom': {type: 'meeting', icon: 'windows', details: 'In a Zoom Meeting'},
          
          // Creative - Use windows icon for creative apps
          'photoshop': {type: 'design', icon: 'windows', details: 'Editing in Photoshop'},
          'illustrator': {type: 'design', icon: 'windows', details: 'Designing in Illustrator'},
          'premiere': {type: 'video', icon: 'windows', details: 'Editing Video'},
          'aftereffects': {type: 'video', icon: 'windows', details: 'Creating Motion Graphics'},
          'figma': {type: 'design', icon: 'windows', details: 'Designing in Figma'},
          'blender': {type: '3d', icon: 'windows', details: '3D Modeling'},
          'unity': {type: 'gamedev', icon: 'windows', details: 'Game Development'},
          'unreal': {type: 'gamedev', icon: 'windows', details: 'Game Development'},
          
          // Games & Gaming Platforms - Use windows icon for gaming
          'steam': {type: 'gaming', icon: 'windows', details: 'Gaming on Steam'},
          'epicgames': {type: 'gaming', icon: 'windows', details: 'Gaming on Epic'},
          'battle.net': {type: 'gaming', icon: 'windows', details: 'Gaming on Battle.net'},
          'league': {type: 'gaming', icon: 'windows', details: 'Playing League of Legends'},
          'valorant': {type: 'gaming', icon: 'windows', details: 'Playing Valorant'},
          'minecraft': {type: 'gaming', icon: 'windows', details: 'Playing Minecraft'},
          'fortnite': {type: 'gaming', icon: 'windows', details: 'Playing Fortnite'},
          
          // Media
          'spotify': {type: 'music', icon: 'spotify', details: 'Listening to Music'},
          'netflix': {type: 'watching', icon: 'windows', details: 'Watching Netflix'},
          'vlc': {type: 'media', icon: 'windows', details: 'Watching Media'},
          'youtube': {type: 'watching', icon: 'windows', details: 'Watching YouTube'},
          'twitch': {type: 'watching', icon: 'windows', details: 'Watching Twitch'}
        };
        
        // Try to match by process name
        for (const [appKey, appInfo] of Object.entries(appMap)) {
          if (processName.toLowerCase().includes(appKey.toLowerCase())) {
            activityType = appInfo.type;
            largeImageKey = appInfo.icon;
            details = appInfo.details;
            matchedApp = true;
            break;
          }
        }
      }
      
      // Override specific cases where the detection isn't working correctly
      if (processName === 'Code') {
        details = 'Coding in VS Code';
        activityType = 'coding';
        largeImageKey = 'vscode';
        
        // For VS Code, extract file type from window title
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
      } else if (processName === 'chrome') {
        details = 'Browsing with Chrome';
        activityType = 'browsing';
        largeImageKey = 'chrome';
        
        // For Chrome, extract the website
        if (windowTitle.includes(' - Google Chrome')) {
          const website = windowTitle.replace(' - Google Chrome', '');
          state = website;
          
          // Special cases for common websites (use standard icon for these)
          if (windowTitle.toLowerCase().includes('youtube')) {
            details = 'Watching YouTube';
            largeImageKey = 'windows'; // Using windows icon for YouTube
            
            // Try to extract video title
            const ytMatch = windowTitle.match(/(.+) - YouTube/);
            if (ytMatch) {
              state = `Watching: ${ytMatch[1].trim()}`;
            }
          } else if (windowTitle.toLowerCase().includes('twitch')) {
            details = 'Watching Twitch';
            largeImageKey = 'windows'; // Using windows icon for Twitch
          } else if (windowTitle.toLowerCase().includes('github')) {
            details = 'Working on GitHub';
            largeImageKey = 'windows'; // Using windows icon for GitHub
          }
        }
      } else if (processName === 'Discord') {
        details = 'Chatting on Discord';
        activityType = 'chat';
        largeImageKey = 'discord';
        
        // Discord status is already handled well in the main detection code
      } else if (processName === 'Spotify') {
        details = 'Listening to Music';
        activityType = 'music';
        largeImageKey = 'spotify';
        
        // Spotify status is already handled well in the main detection code
      } else if (!matchedApp) {
        // Default to Windows icon for any unmatched applications
        largeImageKey = 'windows';
      }
      
      // Always add the process name to the state for debugging
      state = `${state} (${processName})`;
      
      // Track activity timing
      this.trackActivityTime(activityType);
      
      // Reset the start time if the application changed
      // This is the key fix - we check if the process changed
      if (processName !== this.lastProcessName) {
        console.log(`Application changed from ${this.lastProcessName} to ${processName}`);
        this.startTime = Date.now();
        this.lastProcessName = processName;
      }
      
      // Only reset the activity type if it changed
      if (activityType !== this.lastActivity) {
        this.lastActivity = activityType;
      }
      
      // Calculate duration for current activity
      const activityDuration = Date.now() - this.startTime;
      const formattedDuration = this.formatDuration(activityDuration);
      
      // Get system info for additional details
      const cpuUsage = this.getCpuUsage();
      const memoryUsage = this.getMemoryUsage();
      
      return {
        details: details.substring(0, 128), // Discord has character limits
        state: `${state.substring(0, 60)} | ${formattedDuration} | CPU: ${cpuUsage}%, RAM: ${memoryUsage}%`,
        largeImageKey,
        largeImageText: `${activityType.charAt(0).toUpperCase() + activityType.slice(1)} for ${formattedDuration}`,
        smallImageKey: 'info',
        smallImageText: `${os.hostname()} | Today: ${this.formatDuration((this.dailyActivityStats.get(activityType) || 0) * 1000)}`,
        startTimestamp: this.startTime,
        buttons: [
          {
            label: 'Activity Stats',
            url: 'https://discord.com'
          }
        ]
      };
    } catch (error) {
      console.error('Error detecting activity:', error);
      
      // Return default activity on error
      return {
        details: 'Online',
        state: 'Using Windows',
        largeImageKey: 'windows',
        largeImageText: `Windows ${os.release()}`,
        startTimestamp: this.startTime
      };
    }
  }
  
  // Get CPU usage (simplified)
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
  
  // Get RAM usage
  private getMemoryUsage(): number {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const memUsage = Math.round((usedMem / totalMem) * 100);
    return memUsage;
  }
  
  // Format duration in a human-readable way
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
  
  // Track time spent on activities
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
  
  constructor() {
    this.activityTracker = new ActivityTracker();
    
    // Set up event handlers
    client.on('ready', () => {
      console.log('Discord RPC connected!');
      this.startActivityTracking();
    });
    
    // Handle connection errors
    client.on('error', (error) => {
      console.error('Discord RPC error:', error);
      this.reconnect();
    });
  }
  
  // Start the Discord RPC application
  public async start(): Promise<void> {
    try {
      console.log('Starting Discord RPC application...');
      await client.login({ clientId: config.clientId });
    } catch (error) {
      console.error('Failed to connect to Discord:', error);
      this.reconnect();
    }
  }
  
  // Reconnect logic
  private reconnect(): void {
    console.log('Attempting to reconnect in 15 seconds...');
    setTimeout(() => {
      this.start();
    }, 15000);
  }
  
  // Start tracking and updating activity
  private startActivityTracking(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
    }
    
    // Update activity based on config interval for responsive updates
    this.updateInterval = setInterval(async () => {
      try {
        const activity = await this.activityTracker.getCurrentActivity();
        
        // Set the activity
        client.setActivity(activity);
        console.log('Activity updated:', activity.details, activity.state);
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
    
    client.destroy();
    console.log('Discord RPC application stopped.');
  }
}

// Create and start the application
const app = new DiscordRPCApp();
app.start();

// Output message for environments without signal handlers
console.log('Process signal handlers not available in this environment.');
console.log('Close this window to stop the application.');