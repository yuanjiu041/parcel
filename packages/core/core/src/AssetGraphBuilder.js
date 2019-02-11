// @flow
import type {
  ParcelOptions,
  Dependency,
  FilePath,
  Target,
  TransformerRequest
} from '@parcel/types';
import type {Node} from './Graph';
import type Config from './Config';
import EventEmitter from 'events';
import {AbortController} from 'abortcontroller-polyfill/dist/cjs-ponyfill';
import Watcher from '@parcel/watcher';
import PromiseQueue from './PromiseQueue';
import AssetGraph from './AssetGraph';
import ResolverRunner from './ResolverRunner';
import WorkerFarm from '@parcel/workers';

const abortError = new Error('Build aborted');

type Signal = {
  aborted: boolean,
  addEventListener?: Function
};

type BuildOpts = {
  signal: Signal,
  shallow?: boolean
};

type Opts = {|
  options: ParcelOptions,
  config: Config,
  entries?: Array<string>,
  targets?: Array<Target>,
  transformerRequest?: TransformerRequest,
  rootDir: FilePath
|};

export default class AssetGraphBuilder extends EventEmitter {
  graph: AssetGraph;
  watcher: Watcher;
  queue: PromiseQueue;
  resolverRunner: ResolverRunner;
  controller: AbortController;
  farm: WorkerFarm;
  runTransform: (file: TransformerRequest) => Promise<any>;

  constructor(opts: Opts) {
    super();

    this.queue = new PromiseQueue();
    this.resolverRunner = new ResolverRunner({
      config: opts.config,
      options: opts.options,
      rootDir: opts.rootDir
    });

    this.graph = new AssetGraph();
    this.graph.initializeGraph(opts);

    this.controller = new AbortController();
    if (opts.options.watch) {
      this.watcher = new Watcher();
      this.watcher.on('change', async filePath => {
        if (this.graph.hasNode(filePath)) {
          this.controller.abort();
          this.graph.invalidateFile(filePath);

          this.emit('invalidate', filePath);
        }
      });
    }
  }

  async initFarm() {
    // This expects the worker farm to already be initialized by Parcel prior to calling
    // AssetGraphBuilder, which avoids needing to pass the options through here.
    this.farm = await WorkerFarm.getShared();
    this.runTransform = this.farm.mkhandle('runTransform');
  }

  async build() {
    if (!this.farm) {
      await this.initFarm();
    }

    this.controller = new AbortController();
    let signal = this.controller.signal;

    await this.updateGraph({signal});
    await this.completeGraph({signal});
    return this.graph;
  }

  async updateGraph({signal}: BuildOpts) {
    for (let [, node] of this.graph.invalidNodes) {
      this.queue.add(() => this.processNode(node, {signal, shallow: true}));
    }
    await this.queue.run();
  }

  async completeGraph({signal}: BuildOpts) {
    for (let [, node] of this.graph.incompleteNodes) {
      this.queue.add(() => this.processNode(node, {signal}));
    }

    await this.queue.run();
  }

  processNode(node: Node, {signal}: BuildOpts) {
    switch (node.type) {
      case 'dependency':
        return this.resolve(node.value, {signal});
      case 'transformer_request':
        return this.transform(node.value, {signal});
      default:
        throw new Error(
          `Cannot process graph node with type ${node.type || 'undefined'}`
        );
    }
  }

  async resolve(dep: Dependency, {signal}: BuildOpts) {
    let resolvedPath;
    try {
      resolvedPath = await this.resolverRunner.resolve(dep);
    } catch (err) {
      if (err.code === 'MODULE_NOT_FOUND' && dep.isOptional) {
        return;
      }

      throw err;
    }

    if (signal.aborted) {
      throw abortError;
    }

    let req = {filePath: resolvedPath, env: dep.env};
    let {newRequest} = this.graph.resolveDependency(dep, req);

    if (newRequest) {
      this.queue.add(() => this.transform(newRequest, {signal}));
      if (this.watcher) this.watcher.watch(newRequest.filePath);
    }
  }

  async transform(req: TransformerRequest, {signal, shallow}: BuildOpts) {
    let start = Date.now();
    let cacheEntry = await this.runTransform(req);
    let time = Date.now() - start;

    for (let asset of cacheEntry.assets) {
      asset.buildTime = time;
    }

    if (signal.aborted) throw abortError;
    let {
      addedFiles,
      removedFiles,
      newDeps
    } = this.graph.resolveTransformerRequest(req, cacheEntry);

    if (this.watcher) {
      for (let file of addedFiles) {
        this.watcher.watch(file.filePath);
      }

      for (let file of removedFiles) {
        this.watcher.unwatch(file.filePath);
      }
    }

    // The shallow option is used during the update phase
    if (!shallow) {
      for (let dep of newDeps) {
        this.queue.add(() => this.resolve(dep, {signal}));
      }
    }
  }
}
