import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { docker } from '../commands/utils/docker-endpoint';
import * as dockerHubAPI from 'docker-hub-api';
import { AzureAccount, AzureSession } from './azure-account.api';
import * as os from 'os';
import { dockerHubLogin } from './utils/dockerLogin';
import { SubscriptionClient, ResourceManagementClient, SubscriptionModels } from 'azure-arm-resource';
import * as keytarType from 'keytar';
import request = require('request-promise');

const ContainerRegistryManagement = require('azure-arm-containerregistry');
const azureAccount: AzureAccount = vscode.extensions.getExtension<AzureAccount>('ms-vscode.azure-account')!.exports;


export class DockerExplorerProvider implements vscode.TreeDataProvider<DockerNode> {

    private _onDidChangeTreeData: vscode.EventEmitter<DockerNode | undefined> = new vscode.EventEmitter<DockerNode | undefined>();
    readonly onDidChangeTreeData: vscode.Event<DockerNode | undefined> = this._onDidChangeTreeData.event;
    private _imagesNode: DockerNode;
    private _containersNode: DockerNode;
    private _registriesNode: DockerNode;
    private _debounceTimer: NodeJS.Timer;
    private _keytar: typeof keytarType;

    constructor() {
        try {
            this._keytar = require(`${vscode.env.appRoot}/node_modules/keytar`);
        } catch (e) {
            // unable to find keytar
        }
    }

    refresh(): void {
        this.refreshImages()
        this.refreshContainers()
        this.refreshRegistries()
    }

    refreshImages(): void {
        this._onDidChangeTreeData.fire(this._imagesNode);
    }

    refreshContainers(): void {
        this._onDidChangeTreeData.fire(this._containersNode);
    }

    refreshRegistries(): void {
        this._onDidChangeTreeData.fire(this._registriesNode);
    }

    private setAutoRefresh(): void {
        // from https://github.com/formulahendry/vscode-docker-explorer/blob/master/src/dockerTreeBase.ts  
        const configOptions: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration('docker');
        const interval = configOptions.get('explorerRefreshInterval', 1000);

        if (interval > 0) {
            clearTimeout(this._debounceTimer);
            this._debounceTimer = setTimeout(() => {
                this.refreshImages();
                this.refreshContainers();
            }, interval);
        }
    }

    private async getSubscriptions(api: AzureAccount): Promise<SubscriptionItem[]> {

        const subscriptionItems: SubscriptionItem[] = [];
        for (const session of api.sessions) {
            const credentials = session.credentials;
            const subscriptionClient = new SubscriptionClient(credentials);
            const subscriptions = await this.listAll(subscriptionClient.subscriptions, subscriptionClient.subscriptions.list());
            subscriptionItems.push(...subscriptions.map(subscription => ({
                label: subscription.displayName || '',
                description: subscription.subscriptionId || '',
                session,
                subscription
            })));
        }
        subscriptionItems.sort((a, b) => a.label.localeCompare(b.label));

        return subscriptionItems;

    }


    private async listAll<T>(client: { listNext(nextPageLink: string): Promise<PartialList<T>>; }, first: Promise<PartialList<T>>): Promise<T[]> {
        const all: T[] = [];
        for (let list = await first; list.length || list.nextLink; list = list.nextLink ? await client.listNext(list.nextLink) : []) {
            all.push(...list);
        }
        return all;
    }


    getTreeItem(element: DockerNode): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: DockerNode): Promise<DockerNode[]> {
        return this.getDockerNodes(element);
    }

    private async getDockerNodes(element?: DockerNode): Promise<DockerNode[]> {

        let opts = {};
        let iconPath: any = {};
        let contextValue: string = "";
        let node: DockerNode;
        const nodes: DockerNode[] = [];

        if (!element) {
            this._imagesNode = new DockerNode("Images", vscode.TreeItemCollapsibleState.Collapsed, "imagesLabel", null, null);
            this._containersNode = new DockerNode("Containers", vscode.TreeItemCollapsibleState.Collapsed, "containersLabel", null, null);
            this._registriesNode = new DockerNode("Registries", vscode.TreeItemCollapsibleState.Collapsed, "registriesLabel", null, null);
            nodes.push(this._imagesNode);
            nodes.push(this._containersNode);
            nodes.push(this._registriesNode);
            return nodes;
        }

        if (element.contextValue === 'imagesLabel') {
            const images: Docker.ImageDesc[] = await docker.getImageDescriptors();

            if (!images || images.length === 0) {
                return [];
            }

            for (let i = 0; i < images.length; i++) {
                contextValue = "image";
                if (!images[i].RepoTags) {
                    let node = new DockerNode("<none>:<none>", vscode.TreeItemCollapsibleState.None, contextValue);
                    node.imageDesc = images[i];
                    nodes.push(node);
                } else {
                    for (let j = 0; j < images[i].RepoTags.length; j++) {
                        let node = new DockerNode(images[i].RepoTags[j], vscode.TreeItemCollapsibleState.None, contextValue);
                        node.imageDesc = images[i];
                        nodes.push(node);
                    }
                }
            }

            return nodes;

        }

        if (element.contextValue === 'containersLabel') {

            opts = {
                "filters": {
                    "status": ["created", "restarting", "running", "paused", "exited", "dead"]
                }
            };

            const containers: Docker.ContainerDesc[] = await docker.getContainerDescriptors(opts);
            if (!containers || containers.length == 0) {
                return [];
            } else {
                for (let i = 0; i < containers.length; i++) {
                    if (['exited', 'dead'].includes(containers[i].State)) {
                        contextValue = "stoppedContainer";
                        iconPath = {
                            light: path.join(__filename, '..', '..', '..', 'images', 'light', 'mono_moby_small.png'),
                            dark: path.join(__filename, '..', '..', '..', 'images', 'dark', 'mono_moby_small.png')
                        };
                    } else {
                        contextValue = "runningContainer";
                        iconPath = {
                            light: path.join(__filename, '..', '..', '..', 'images', 'light', 'moby_small.png'),
                            dark: path.join(__filename, '..', '..', '..', 'images', 'dark', 'moby_small.png')
                        };
                    }

                    const containerName = containers[i].Names[0].substring(1);
                    let node = new DockerNode(`${containers[i].Image} (${containerName}) [${containers[i].Status}]`, vscode.TreeItemCollapsibleState.None, contextValue, null, iconPath);
                    node.containerDesc = containers[i];
                    nodes.push(node);

                }
            }

            return nodes;

        }

        if (element.contextValue === 'registriesLabel') {

            contextValue = "dockerHubRegistry";
            node = new DockerNode(`Docker Hub`, vscode.TreeItemCollapsibleState.Collapsed, contextValue, null, null);
            nodes.push(node);

            const loggedIntoAzure: boolean = await azureAccount.waitForLogin()

            if (loggedIntoAzure) {
                const subs = await this.getSubscriptions(azureAccount);

                for (let i = 0; i < subs.length; i++) {
                    contextValue = 'azureSubscription';
                    node = new DockerNode(subs[i].label, vscode.TreeItemCollapsibleState.Collapsed, contextValue, null, null);
                    node.subscription = subs[i];
                    nodes.push(node);
                }
            }

            return nodes;

        }

        if (element.contextValue === 'dockerHubRegistry') {

            let token: string;

            if (this._keytar) {
                token = await this._keytar.getPassword('vscode-docker', 'dockerhub');
            }

            if (!token) {
                token = await dockerHubLogin();
                if (token) {
                    dockerHubAPI.setLoginToken(token);
                    if (this._keytar) {
                        this._keytar.setPassword('vscode-docker', 'dockerhub', token);
                    }
                } else {
                    return [];
                }
            } else {
                dockerHubAPI.setLoginToken(token);
            }

            const user: any = await dockerHubAPI.loggedInUser();

            const myRepos = await dockerHubAPI.repositories(user.username);
            for (let i = 0; i < myRepos.length; i++) {
                const myRepo = await dockerHubAPI.repository(myRepos[i].namespace, myRepos[i].name);
                contextValue = 'dockerHubRegistryImage';
                let node = new DockerNode(`${myRepo.namespace}/${myRepo.name}`, vscode.TreeItemCollapsibleState.Collapsed, contextValue, null, null);
                node.repository = myRepo;
                nodes.push(node);
            }

            return nodes;
        }

        if (element.contextValue === 'dockerHubRegistryImage') {
            let myTags = await dockerHubAPI.tags(element.repository.namespace, element.repository.name);
            for (let i = 0; i < myTags.length; i++) {
                contextValue = 'dockerHubRegistryImageTag';
                nodes.push(new DockerNode(`${element.repository.name}:${myTags[i].name}`, vscode.TreeItemCollapsibleState.None, contextValue, null, null));
            }

            return nodes;
        }

        if (element.contextValue === 'azureSubscription') {
            const client = new ContainerRegistryManagement(element.subscription.session.credentials, element.subscription.subscription.subscriptionId);
            const registries = await client.registries.list();
            for (let i = 0; i < registries.length; i++) {
                contextValue = 'azureRegistry';
                node = new DockerNode(registries[i].loginServer, vscode.TreeItemCollapsibleState.Collapsed, contextValue, null, null);
                node.subscription = element.subscription;
                nodes.push(node);
            }

            return nodes;
        }

        if (element.contextValue === 'azureRegistry') {

            const { accessToken, refreshToken } = await acquireToken(element.subscription.session);

            if (accessToken && refreshToken) {
                const tenantId = element.subscription.subscription.tenantId;
                let refreshTokenARC;
                let accessTokenARC;

                await request.post('https://' + element.label + '/oauth2/exchange', {
                    form: {
                        grant_type: 'access_token_refresh_token',
                        service: element.label,
                        tenant: tenantId,
                        refresh_token: refreshToken,
                        access_token: accessToken
                    }
                }, (err, httpResponse, body) => {
                    if (body.length > 0) {
                        refreshTokenARC = JSON.parse(body).refresh_token;
                    } else {
                        return [];
                    }
                });

                await request.post('https://' + element.label + '/oauth2/token', {
                    form: {
                        grant_type: 'refresh_token',
                        service: element.label,
                        scope: 'registry:catalog:*',
                        refresh_token: refreshTokenARC
                    }
                }, (err, httpResponse, body) => {
                    if (body.length > 0) {
                        accessTokenARC = JSON.parse(body).access_token;
                    } else {
                        return [];
                    }
                });

                await request.get('https://' + element.label + '/v2/_catalog', {
                    auth: {
                        bearer: accessTokenARC
                    }
                }, (err, httpResponse, body) => {
                    if (body.length > 0) {
                        const repositories = JSON.parse(body).repositories;
                        for (let i = 0; i < repositories.length; i++) {
                            contextValue = "azureRepository";
                            node = new DockerNode(repositories[i], vscode.TreeItemCollapsibleState.Collapsed, contextValue, null, null);
                            node.repository = element.label;
                            node.subscription = element.subscription;
                            node.accessTokenARC = accessTokenARC;
                            node.refreshTokenARC = refreshTokenARC;
                            nodes.push(node);
                        }
                    } else {
                        vscode.window.showWarningMessage("no repos");
                    }
                });

                return nodes;

            }

        }

        if (element.contextValue === 'azureRepository') {

            const { accessToken, refreshToken } = await acquireToken(element.subscription.session);

            if (accessToken && refreshToken) {
                const tenantId = element.subscription.subscription.tenantId;
                let refreshTokenARC;
                let accessTokenARC;

                await request.post('https://' + element.repository + '/oauth2/exchange', {
                    form: {
                        grant_type: 'access_token_refresh_token',
                        service: element.repository,
                        tenant: tenantId,
                        refresh_token: refreshToken,
                        access_token: accessToken
                    }
                }, (err, httpResponse, body) => {
                    if (body.length > 0) {
                        refreshTokenARC = JSON.parse(body).refresh_token;
                    } else {
                        return [];
                    }
                });

                await request.post('https://' + element.repository + '/oauth2/token', {
                    form: {
                        grant_type: 'refresh_token',
                        service: element.repository,
                        scope: 'repository:' + element.label + ':pull',
                        refresh_token: refreshTokenARC
                    }
                }, (err, httpResponse, body) => {
                    if (body.length > 0) {
                        accessTokenARC = JSON.parse(body).access_token;
                    } else {
                        return [];
                    }
                });

                await request.get('https://' + element.repository + '/v2/' + element.label + '/tags/list', {
                    auth: {
                        bearer: accessTokenARC
                    }
                }, (err, httpResponse, body) => {
                    if (err) { return []; }
                    if (body.length > 0) {
                        const tags = JSON.parse(body).tags;
                        for (let i = 0; i < tags.length; i++) {
                            contextValue = "azureRepositoryTag";
                            node = new DockerNode(element.label + ':' + tags[i], vscode.TreeItemCollapsibleState.None, contextValue, null, null);
                            node.repository = element.repository;
                            node.subscription = element.subscription;
                            node.accessTokenARC = accessTokenARC;
                            node.refreshTokenARC = element.refreshTokenARC;
                            nodes.push(node);
                        }
                    }
                });

                return nodes;
            }
        }
    }
}


async function acquireToken(session: AzureSession) {
    return new Promise<{ accessToken: string; refreshToken: string; }>((resolve, reject) => {
        const credentials: any = session.credentials;
        const environment: any = session.environment;
        credentials.context.acquireToken(environment.activeDirectoryResourceId, credentials.username, credentials.clientId, function (err: any, result: any) {
            if (err) {
                reject(err);
            } else {
                resolve({
                    accessToken: result.accessToken,
                    refreshToken: result.refreshToken
                });
            }
        });
    });
}


export class DockerNode extends vscode.TreeItem {

    constructor(public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly contextValue: string,
        public readonly command?: vscode.Command,
        public iconPath: any = {
            light: path.join(__filename, '..', '..', '..', 'images', 'light', 'mono_moby_small.png'),
            dark: path.join(__filename, '..', '..', '..', 'images', 'dark', 'mono_moby_small.png')
        }) {

        super(label, collapsibleState);
    }

    public containerDesc: Docker.ContainerDesc;
    public imageDesc: Docker.ImageDesc;
    public repository: any = {};
    public subscription: SubscriptionItem;
    public refreshTokenARC: string;
    public accessTokenARC: string;
}

enum RegistryType {
    Docker,
    Azure,
    Unknown
}


class Registry {
    url: string;
    registryType: RegistryType;
    userName: string;
    password: string;
    token: string;
    friendlyName: string;
}

interface SubscriptionItem {
    label: string;
    description: string;
    session: AzureSession;
    subscription: SubscriptionModels.Subscription;
}

interface PartialList<T> extends Array<T> {
    nextLink?: string;
}


