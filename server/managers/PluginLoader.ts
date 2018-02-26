/**
 * @author Santhosh Vasabhaktula <santhosh@ilimi.in>
 */

import { Manifest, IPluginManifest } from "../models/Manifest";
import { IRouterConstructor, IServerConstructor, IPlugin, FrameworkConfig } from '../interfaces';
import { FrameworkError, FrameworkErrors } from "../util";
import { PluginRegistry } from "./PluginRegistry";
import { PluginManager } from "./PluginManager";
import { RouterRegistry } from "./RouterRegistry";
import * as _ from 'lodash';
import { SchemaLoader, ISchemaLoader } from '../db';
import * as glob from 'glob';

export class PluginLoader {

    private _config: FrameworkConfig;
    private _pluginsLoaded: Array<string> = [];

    constructor(config: FrameworkConfig) {
        this._config = _.cloneDeep(config);
    }

    get config(): FrameworkConfig {
        return this._config;
    }

    private async loadDependencies(manifest: Manifest) {
        for(let dependency of manifest.server.dependencies) {
            if(this._pluginsLoaded.indexOf(dependency.id) == -1) {
                await this.loadPlugin(dependency);
            }
        }
    }

    /**
     * Steps:
     *  1) Put a placeholder to indicate that this plugin is triggered for load so the cyclic dependencies don't kill the process
     *  2) Load manifest
     *  3) Load dependencies first
     *  4) Register the plugin
     *  5) Prepare the plugin - create/alter schema, run migration
     *  6) Instantiate the plugin
     *  7) Register the routes
     *
     * @param plugin IPlugin
     */
    public async loadPlugin(plugin: IPlugin) {
        
        this._pluginsLoaded.push(plugin.id); // Step 1
        const manifest = await this.getManifest(plugin); // Step 2
        const pluginManifest = _.cloneDeep(manifest);
        if(typeof(manifest.server.dependencies) !== undefined) { // Step 3
            await this.loadDependencies(pluginManifest);
        }
        //await PluginRegistry.register(pluginManifest); // Step 4
        await this.preparePlugin(pluginManifest) // Step 5
        await this.instantiatePlugin(pluginManifest) // Step 6
        await this.registerRoutes(pluginManifest) // Step 7
    }

    private async getManifest(plugin: IPlugin) {
        try {
            //TODO: Look for multiple paths
            const pluginId = plugin.id;
		    const pluginManifest = await import(this.config.pluginBasePath + pluginId + '/manifest');
		    return Manifest.fromJSON(<IPluginManifest> pluginManifest.manifest);
        } catch(err) {
            throw new FrameworkError({code: FrameworkErrors.MANIFEST_NOT_FOUND, rootError: err});
        }
    }

    private async preparePlugin(manifest: Manifest) {
        // PluginRegistry checks if database schema is created for the plugin
        // if migration, do migration
        // if not, db schema for the plugin should be created
        await this.loadDBSchema(manifest);
    }

    private async instantiatePlugin(manifest: Manifest) {
        try {
            let pluginFile = await import(this.config.pluginBasePath + manifest.id + '/server');
			let pluginClass = <IServerConstructor> pluginFile.Server;
			let pluginInstance = new pluginClass(this.config, manifest);
            PluginManager.instances[manifest.id] = pluginInstance;
        } catch (err) {
            throw new FrameworkError({code: FrameworkErrors.PLUGIN_LOAD_FAILED, rootError: err});
        }
    }

    private async registerRoutes(manifest: Manifest) {
        try {
            let router = RouterRegistry.getRouter(manifest);
			let pluginRouter = await import(this.config.pluginBasePath + manifest.id + '/routes');
			pluginRouter = <IRouterConstructor>pluginRouter.Router;
			const routerInstance = new pluginRouter();
			routerInstance.init(router, manifest);
        } catch (err) {
            throw new FrameworkError({code: FrameworkErrors.ROUTE_REGISTRY_FAILED, rootError: err});
        }
    }

    private async loadDBSchema(manifest: Manifest) {
		glob(this.config.pluginBasePath + manifest.id + '/db/**/schema*.json', {}, (err, files) => {
			files.forEach(async (path) => {
				try {
					let schema = await import(path);
					let schemaLoader = <ISchemaLoader>SchemaLoader.getLoader(schema.type);
					await schemaLoader.create(manifest, schema);
				} catch(error) {
					throw new FrameworkError({code: FrameworkErrors.SCHEMA_LOADER_FAILED, rootError: error});
				}
			})
		})	
	}
}