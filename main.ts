import { App, normalizePath, Notice, Plugin, PluginSettingTab, Setting, requestUrl, TFile } from 'obsidian';

const TASK_TEMPLATE_MD: string = "# {0}\n{1}\n\nLink: {2}\n\n#todo:\n- [ ] Create todo list\n- [ ] \n## Notes:\n"; // Title, Tags
const BOARD_TEMPLATE_MD: string = "---\n\nkanban-plugin: basic\n\n---\n\n## Pending\n{0}\n## In Progress\n{1}\n## In Merge\n{2}\n## In Verification\n{3}\n## Closed\n**Complete**\n{4}\n%% kanban:settings\n\`\`\`\n{\"kanban-plugin\":\"basic\"}\n\`\`\`%%\"";

const TASKS_QUERY: string = "{\"query\": \"Select [System.Id], [System.Title], [System.State] From WorkItems Where [Assigned to] = \\\"{0}\\\"\"}" // username

// TODO: replace with columns pulled from Azure Devops
const COLUMN_PENDING = "Pending";
const COLUMN_IN_PROGRESS = "In Progress";
const COLUMN_IN_MERGE = "In Merge";
const COLUMN_IN_VERIFICATION = "In Verification";
const COLUMN_CLOSED= "Closed";

interface AzureDevopsPluginSettings {
	instance: string;
  collection: string;
  project: string;
  team: string,
  username: string,
  accessToken: string,
  targetFolder: string
}

const DEFAULT_SETTINGS: AzureDevopsPluginSettings = {
	instance: '',
  collection: 'DefaultCollection',
  project: '',
  team: '',
  username: '',
  accessToken: '',
  targetFolder: ''
}

export default class AzureDevopsPlugin extends Plugin {
	settings: AzureDevopsPluginSettings;

	async onload() {
		await this.loadSettings();

		// This creates an icon in the left ribbon.
		this.addRibbonIcon('dice', 'Update Boards', (evt: MouseEvent) => {
			this.updateCurrentSprintBoard();
		});

		// This adds a command that can be triggered anywhere
		this.addCommand({
			id: 'update-all-boards',
			name: 'Update all Kanban boards',
			callback: () => {
				this.updateCurrentSprintBoard();
			}
		});

		this.addSettingTab(new AzureDevopsPluginSettingTab(this.app, this));
	}

	onunload() {

	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

  private async updateCurrentSprintBoard() {

    var encoded64PAT = Buffer.from(`:${this.settings.accessToken}`).toString("base64");

    const headers = {
      "Authorization": `Basic ${encoded64PAT}`,
      "Content-Type": "application/json"
    }

    const BaseURL = `https://${this.settings.instance}/${this.settings.collection}/${this.settings.project}`;

    var username = this.settings.username.replace("\'", "\\'");

    var iterationResponse = await requestUrl({ method: 'GET', headers: headers, url: `${BaseURL}/${this.settings.team}/_apis/work/teamsettings/iterations?$timeframe=current&api-version=6.0` });
    var tasksReponse = await requestUrl({method: 'POST', body: TASKS_QUERY.format(username), headers: headers, url: `${BaseURL}/${this.settings.team}/_apis/wit/wiql?api-version=6.0` });

    if (iterationResponse.status != 200) {
      this.logError(iterationResponse.json);
    }
    if (tasksReponse.status != 200) {
      this.logError(iterationResponse.json);
    }

    var currentSprint = iterationResponse.json.value[0];
    var userAssignedTaskIds = tasksReponse.json.workItems;
    var normalizedFolderPath =  normalizePath(this.settings.targetFolder + '/' + currentSprint.path);

    var userAssignedTasks = await Promise.all(userAssignedTaskIds.map((task: any) => requestUrl({ method: 'GET', headers: headers, url: task.url}).then((r) => r.json)));

    // Ensure folder structure created
    this.createFolders(normalizedFolderPath);

    // Get user's assigned tasks in current sprint
    var tasksInCurrentSprint = userAssignedTasks.filter(task => task.fields["System.IterationPath"] === currentSprint.path);

    // Create markdown files based on remote task in current sprint
    var promisesToCreateNotes: Promise<TFile>[] = [];
    tasksInCurrentSprint.forEach(task => { 
      if (this.getFilenameByTaskId(task.id).length === 0) {
        promisesToCreateNotes.push(this.createTaskNote(normalizedFolderPath, task));
      }
    });

    await Promise.all(promisesToCreateNotes); //Await since KanbamBoard depends on files being created (filenames)

    // Create or replace Kanban board of current sprint
    this.createKanbanBoard(normalizedFolderPath, tasksInCurrentSprint, currentSprint.name);

    new Notice('Updated all Kanban boards successfully!');
  }

  private logError(error: string): void {
    console.log(error);
    new Notice('Error occured, see console logs for details. (ctrl+shift+i) to open');
  }

  private createFolders(path: string) {
    if (this.app.vault.getAbstractFileByPath(path) == null) {
      this.app.vault.createFolder(path)
      .catch(err => console.log(err));
    }
  }

  private getFilenameByTaskId(id: string) : string {
    const files = this.app.vault.getMarkdownFiles()

    for (let i = 0; i < files.length; i++) {
      if (files[i].path.contains(id)) {

        var partsOfPath = files[i].path.split("/");
        var filename = partsOfPath[partsOfPath.length - 1];
        
        return filename.substring(0, filename.length-3);; // remove ".md"
      }
    }

    return "";
  }

  private async createTaskNote(path: string, task: any): Promise<TFile> {
    var filename = this.formatTaskFilename(task.fields["System.WorkItemType"], task.id);
    var filepath = path + `/${filename}.md`;
    var originalLink = `https://${this.settings.instance}/${this.settings.collection}/${this.settings.project}/_workitems/edit/${task.id}`;

    return this.app.vault.create(filepath, TASK_TEMPLATE_MD.format(task.fields["System.Title"], `#${task.fields["System.WorkItemType"].replace(/ /g,'')}`, originalLink));
  }

  private createKanbanBoard(path: string, tasks: Array<any>, sprintName: string) {
    var filename = `${sprintName}-Board`;
    var filepath = path + `/${filename}.md`;
    var file = this.app.vault.getAbstractFileByPath(filepath);

    if (file != null) {
      this.app.vault.delete(file, true);
    }
    
    var tasksInPendingState = this.formatTaskLinks(this.filterTasksInColumn(tasks, COLUMN_PENDING)).join('\n');
    var tasksInProgressState = this.formatTaskLinks(this.filterTasksInColumn(tasks, COLUMN_IN_PROGRESS)).join('\n');
    var tasksInMergeState = this.formatTaskLinks(this.filterTasksInColumn(tasks, COLUMN_IN_MERGE)).join('\n');
    var tasksInVerificationState = this.formatTaskLinks(this.filterTasksInColumn(tasks, COLUMN_IN_VERIFICATION)).join('\n');
    var tasksInClosedState = this.formatTaskLinks(this.filterTasksInColumn(tasks, COLUMN_CLOSED)).join('\n');


    this.app.vault.create(filepath, BOARD_TEMPLATE_MD.format(tasksInPendingState,tasksInProgressState,tasksInMergeState,tasksInVerificationState,tasksInClosedState))
        .catch(err => console.log(err));
  }

  private filterTasksInColumn(tasks: Array<any>, column: string): Array<any> {
    return tasks.filter(task => task.fields["System.State"] === column);
  }

  private formatTaskLinks(tasks: Array<any>): Array<string> {
    return tasks.map(task => `- [ ] [[${this.getFilenameByTaskId(task.id)}]] \n ${task.fields["System.Title"]}`);
  }

  private formatTaskFilename(type: string, id: number) {
    return `${type} - ${id}`
  }
}

class AzureDevopsPluginSettingTab extends PluginSettingTab {
	plugin: AzureDevopsPlugin;

	constructor(app: App, plugin: AzureDevopsPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		containerEl.createEl('h2', {text: 'AzureDevops Remote Repo Settings'});

		new Setting(containerEl)
			.setName('Instance')
			.setDesc('TFS server name (BaseURL)')
			.addText(text => text
				.setPlaceholder('Enter instance base url')
				.setValue(this.plugin.settings.instance)
				.onChange(async (value) => {
					this.plugin.settings.instance = value;
					await this.plugin.saveSettings();
				}));

    new Setting(containerEl)
    .setName('Collection')
    .setDesc('The name of the Azure DevOps collection')
    .addText(text => text
      .setPlaceholder('Enter Collection Name')
      .setValue(this.plugin.settings.collection)
      .onChange(async (value) => {
        this.plugin.settings.collection = value;
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
    .setName('Project')
    .setDesc('AzureDevops Project ID or project name')
    .addText(text => text
      .setPlaceholder('Enter project name')
      .setValue(this.plugin.settings.project)
      .onChange(async (value) => {
        this.plugin.settings.project = value;
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
    .setName('Team')
    .setDesc('AzureDevops Team ID or team name')
    .addText(text => text
      .setPlaceholder('Enter team name')
      .setValue(this.plugin.settings.team)
      .onChange(async (value) => {
        this.plugin.settings.team = value;
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
    .setName('Username')
    .setDesc('Your AzureDevops username (display name)')
    .addText(text => text
      .setPlaceholder('Enter your name')
      .setValue(this.plugin.settings.username)
      .onChange(async (value) => {
        this.plugin.settings.username = value;
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
    .setName('Personal Access Token')
    .setDesc('Your AzureDevops PAT with full access')
    .addText(text => text
      .setPlaceholder('Enter your PAT')
      .setValue(this.plugin.settings.accessToken)
      .onChange(async (value) => {
        this.plugin.settings.accessToken = value;
        await this.plugin.saveSettings();
      }));

    containerEl.createEl('h2', {text: 'Plugin Settings'});

    new Setting(containerEl)
    .setName('Target Folder (Optional)')
    .setDesc('The relative path to the parent folder in which to create/update Kanban boards')
    .addText(text => text
      .setPlaceholder('Enter target folder')
      .setValue(this.plugin.settings.targetFolder)
      .onChange(async (value) => {
        this.plugin.settings.targetFolder = value;
        await this.plugin.saveSettings();
      }));

	}
}
