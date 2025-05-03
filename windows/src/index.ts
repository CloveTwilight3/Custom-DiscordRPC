// Discord RPC Application for Windows
// This application updates your Discord status based on system activity

import { Client } from 'discord-rpc';
import * as os from 'os';
import * as process from 'process';
import * as fs from 'fs';
import * as path from 'path';
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
  private startTime: number = Date.now();
  private activityTimers: Map<string, number> = new Map();
  private dailyActivityStats: Map<string, number> = new Map();
  
  // Get current active application
  public async getCurrentActivity(): Promise<ActivityData> {
    try {
      // Windows-specific code to get active window title
      const activeWindowCommand = 'powershell.exe "Get-Process | Where-Object {$_.MainWindowTitle -ne \'\'} | Select-Object MainWindowTitle, ProcessName | ConvertTo-Json"';
      const result = childProcess.execSync(activeWindowCommand).toString();
      
      // Parse the JSON result
      const windowsInfo = JSON.parse(result);
      
      // Find the most likely active window (this is a simplification)
      const activeWindow = Array.isArray(windowsInfo) 
        ? windowsInfo[0] 
        : windowsInfo;
      
      const windowTitle = activeWindow.MainWindowTitle;
      const processName = activeWindow.ProcessName;
      
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
            details = app.details;
            state = windowTitle;
            matchedApp = true;
            break;
          }
        }
      }
      
      // If still no match, use the common applications mapping
      if (!matchedApp) {
        // Common applications mapping
        const appMap: Record<string, {type: string, icon: string, details: string}> = {
          // Browsers
          'chrome': {type: 'browsing', icon: 'chrome', details: 'Browsing with Chrome'},
          'firefox': {type: 'browsing', icon: 'firefox', details: 'Browsing with Firefox'},
          'edge': {type: 'browsing', icon: 'edge', details: 'Browsing with Edge'},
          'brave': {type: 'browsing', icon: 'brave', details: 'Browsing with Brave'},
          'opera': {type: 'browsing', icon: 'opera', details: 'Browsing with Opera'},
          
          // Development
          'code': {type: 'coding', icon: 'vscode', details: 'Coding in VS Code'},
          'visual studio': {type: 'coding', icon: 'vs', details: 'Developing in Visual Studio'},
          'intellij': {type: 'coding', icon: 'intellij', details: 'Coding in IntelliJ'},
          'pycharm': {type: 'coding', icon: 'pycharm', details: 'Coding in PyCharm'},
          'android studio': {type: 'coding', icon: 'android', details: 'Android Development'},
          'sublime': {type: 'coding', icon: 'sublime', details: 'Coding in Sublime'},
          'notepad++': {type: 'coding', icon: 'notepad', details: 'Editing in Notepad++'},
          
          // Productivity
          'word': {type: 'writing', icon: 'word', details: 'Writing in Word'},
          'excel': {type: 'spreadsheet', icon: 'excel', details: 'Working in Excel'},
          'powerpoint': {type: 'presentation', icon: 'powerpoint', details: 'Creating a Presentation'},
          'outlook': {type: 'email', icon: 'outlook', details: 'Checking Email'},
          'onenote': {type: 'notes', icon: 'onenote', details: 'Taking Notes'},
          'teams': {type: 'meeting', icon: 'teams', details: 'In a Meeting'},
          'slack': {type: 'chat', icon: 'slack', details: 'Chatting on Slack'},
          'discord': {type: 'chat', icon: 'discord', details: 'Chatting on Discord'},
          'zoom': {type: 'meeting', icon: 'zoom', details: 'In a Zoom Meeting'},
          
          // Creative
          'photoshop': {type: 'design', icon: 'photoshop', details: 'Editing in Photoshop'},
          'illustrator': {type: 'design', icon: 'illustrator', details: 'Designing in Illustrator'},
          'premiere': {type: 'video', icon: 'premiere', details: 'Editing Video'},
          'aftereffects': {type: 'video', icon: 'aftereffects', details: 'Creating Motion Graphics'},
          'figma': {type: 'design', icon: 'figma', details: 'Designing in Figma'},
          'blender': {type: '3d', icon: 'blender', details: '3D Modeling'},
          'unity': {type: 'gamedev', icon: 'unity', details: 'Game Development'},
          'unreal': {type: 'gamedev', icon: 'unreal', details: 'Game Development'},
          
          // Games & Gaming Platforms
          'steam': {type: 'gaming', icon: 'steam', details: 'Gaming on Steam'},
          'epicgames': {type: 'gaming', icon: 'epic', details: 'Gaming on Epic'},
          'battle.net': {type: 'gaming', icon: 'battlenet', details: 'Gaming on Battle.net'},
          'league': {type: 'gaming', icon: 'league', details: 'Playing League of Legends'},
          'valorant': {type: 'gaming', icon: 'valorant', details: 'Playing Valorant'},
          'minecraft': {type: 'gaming', icon: 'minecraft', details: 'Playing Minecraft'},
          'fortnite': {type: 'gaming', icon: 'fortnite', details: 'Playing Fortnite'},
          
          // Media
          'spotify': {type: 'music', icon: 'spotify', details: 'Listening to Music'},
          'netflix': {type: 'watching', icon: 'netflix', details: 'Watching Netflix'},
          'vlc': {type: 'media', icon: 'vlc', details: 'Watching Media'},
          'youtube': {type: 'watching', icon: 'youtube', details: 'Watching YouTube'},
          'twitch': {type: 'watching', icon: 'twitch', details: 'Watching Twitch'}
        };
      
        // If no specific app was matched, use default detection
        if (windowTitle.toLowerCase().includes('youtube') || 
            windowTitle.toLowerCase().includes('netflix') ||
            windowTitle.toLowerCase().includes('prime video')) {
          activityType = 'watching';
          largeImageKey = 'video';
          details = 'Watching Videos';
        } else if (windowTitle.toLowerCase().includes('game') ||
                  windowTitle.toLowerCase().includes('playing')) {
          activityType = 'gaming';
          largeImageKey = 'game';
          details = 'Gaming';
        }
      }
      
      // Track activity timing
      this.trackActivityTime(activityType);
      
      // Only reset the start time if the activity type changed
      if (activityType !== this.lastActivity) {
        this.startTime = Date.now();
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

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down...');
  app.stop();
  process.exit(0);
});