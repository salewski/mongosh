/* eslint-disable complexity */
import { MongoshInternalError } from '@mongosh/errors';
import type { ReplPlatform } from '@mongosh/service-provider-core';
import { Mongo, ShellInternalState } from '.';
import {
  ALL_PLATFORMS,
  ALL_SERVER_VERSIONS,
  ALL_API_VERSIONS,
  ALL_TOPOLOGIES,
  asPrintable,
  namespaceInfo, shellApiType, Topologies
} from './enums';
import Help from './help';
import { addHiddenDataProperty } from './helpers';
import { checkInterrupted } from './interruptor';

const addSourceToResultsSymbol = Symbol.for('@@mongosh.addSourceToResults');
const resultSource = Symbol.for('@@mongosh.resultSource');

export interface ShellApiInterface {
  [shellApiType]: string;
  [asPrintable]?: () => any;
  serverVersions?: [string, string];
  apiVersions?: [number, number];
  topologies?: Topologies[];
  help?: Help;
  [key: string]: any;
}

export interface Namespace {
  db: string;
  collection: string;
}

export interface ShellResultSourceInformation {
  namespace: Namespace;
}

export interface ShellResult {
  /// The original result of the evaluation, as it would be stored e.g. as a
  /// variable inside the shell.
  rawValue: any;

  /// A version of the raw value that is usable for printing, e.g. what the
  /// shell would print.
  printable: any;

  /// The type of the shell result. This refers to built-in shell types, e.g.
  /// `Cursor`; all unknown object types and primitives are given the
  /// type `null`.
  type: string | null;

  /// Optional information about the original data source of the result.
  source?: ShellResultSourceInformation;
}

export abstract class ShellApiClass implements ShellApiInterface {
  public help: any;

  abstract get _internalState(): ShellInternalState;

  get [shellApiType](): string {
    throw new MongoshInternalError('Shell API Type did not use decorators');
  }
  set [shellApiType](value: string) {
    addHiddenDataProperty(this, shellApiType, value);
  }
  [asPrintable](): any {
    if (Array.isArray(this)) {
      return [...this];
    }
    return { ...this };
  }
}

export abstract class ShellApiWithMongoClass extends ShellApiClass {
  abstract get _mongo(): Mongo;

  get _internalState(): ShellInternalState {
    // _mongo can be undefined in tests
    return this._mongo?._internalState;
  }
}

export abstract class ShellApiValueClass extends ShellApiClass {
  get _mongo(): Mongo {
    throw new MongoshInternalError('Not supported on this value class');
  }

  get _internalState(): ShellInternalState {
    throw new MongoshInternalError('Not supported on this value class');
  }
}

export function getShellApiType(rawValue: any): string | null {
  return (rawValue && rawValue[shellApiType]) ?? null;
}

export async function toShellResult(rawValue: any): Promise<ShellResult> {
  if ((typeof rawValue !== 'object' && typeof rawValue !== 'function') || rawValue === null) {
    return {
      type: null,
      rawValue: rawValue,
      printable: rawValue
    };
  }

  if ('then' in rawValue && typeof rawValue.then === 'function') {
    // Accepting Promises for the actual values here makes life a bit easier
    // in the Java shell.
    return toShellResult(await rawValue);
  }

  const printable =
    typeof rawValue[asPrintable] === 'function' ? await rawValue[asPrintable]() : rawValue;
  const source = rawValue[resultSource] ?? undefined;

  return {
    type: getShellApiType(rawValue),
    rawValue: rawValue,
    printable: printable,
    source: source
  };
}

// For classes like Collection, it can be useful to attach information to the
// result about the original data source, so that downstream consumers of the
// shell can e.g. figure out how to edit a document returned from the shell.
// To that end, we wrap the methods of a class, and report back how the
// result was generated.
// We also attach the `shellApiType` property to the
// return type (if that is possible and they are not already present), so that
// we can also provide sensible information for methods that do not return
// shell classes, like db.coll.findOne() which returns a Document (i.e. a plain
// JavaScript object).
function wrapWithAddSourceToResult(fn: Function): Function {
  function addSource<T extends {}>(result: T, obj: any): T {
    if (typeof result === 'object' && result !== null) {
      const resultSourceInformation: ShellResultSourceInformation = {
        namespace: obj[namespaceInfo](),
      };
      addHiddenDataProperty(result, resultSource, resultSourceInformation);
      if ((result as any)[shellApiType] === undefined && (fn as any).returnType) {
        addHiddenDataProperty(result, shellApiType, (fn as any).returnType);
      }
    }
    return result;
  }
  const wrapper = (fn as any).returnsPromise ?
    markImplicitlyAwaited(async function(this: any, ...args: any[]): Promise<any> {
      return addSource(await fn.call(this, ...args), this);
    }) : function(this: any, ...args: any[]): any {
      return addSource(fn.call(this, ...args), this);
    };
  Object.setPrototypeOf(wrapper, Object.getPrototypeOf(fn));
  Object.defineProperties(wrapper, Object.getOwnPropertyDescriptors(fn));
  return wrapper;
}

function wrapWithApiChecks<T extends(...args: any[]) => any>(fn: T, className: string): (args: Parameters<T>) => ReturnType<T> {
  const wrapper = (fn as any).returnsPromise ?
    markImplicitlyAwaited(async function(this: any, ...args: any[]): Promise<any> {
      const internalState = getShellInternalState(this);
      checkForDeprecation(internalState, className, fn);
      const interruptFlag = checkInterrupted(internalState);
      const interrupt = interruptFlag?.asPromise();

      let result: any;
      try {
        result = await Promise.race([
          interrupt?.promise ?? new Promise<never>(() => {}),
          fn.call(this, ...args)
        ]);
      } catch (e) {
        throw internalState?.transformError(e) ?? e;
      } finally {
        if (interrupt) {
          interrupt.destroy();
        }
      }
      checkInterrupted(internalState);
      return result;
    }) : function(this: any, ...args: any[]): any {
      const internalState = getShellInternalState(this);
      checkForDeprecation(internalState, className, fn);
      checkInterrupted(internalState);
      let result: any;
      try {
        result = fn.call(this, ...args);
      } catch (e) {
        throw internalState?.transformError(e) ?? e;
      }
      checkInterrupted(internalState);
      return result;
    };
  Object.setPrototypeOf(wrapper, Object.getPrototypeOf(fn));
  Object.defineProperties(wrapper, Object.getOwnPropertyDescriptors(fn));
  return wrapper;
}

function checkForDeprecation(internalState: ShellInternalState | undefined, className: string, fn: any) {
  if (internalState && typeof internalState.emitDeprecatedApiCall === 'function' && typeof fn === 'function' && fn.deprecated) {
    internalState.emitDeprecatedApiCall({
      method: fn.name,
      class: className
    });
  }
}

function getShellInternalState(apiClass: any): ShellInternalState | undefined {
  if (!apiClass[shellApiType]) {
    throw new MongoshInternalError('getShellInternalState can only be called for functions from shell API classes');
  }
  // internalState can be undefined in tests
  return (apiClass as ShellApiClass)._internalState;
}

// This is a bit more restrictive than `AutocompleteParameters` used in the
// internal state code, so that it can also be accessed by testing code in the
// autocomplete package. You can expand this type to be closed to `AutocompleteParameters`
// as needed.
export interface ShellCommandAutocompleteParameters {
  getCollectionCompletionsForCurrentDb: (collName: string) => string[] | Promise<string[]>;
  getDatabaseCompletions: (dbName: string) => string[] | Promise<string[]>;
}
// Provide a suggested list of completions for the last item in a shell command,
// e.g. `show pro` to `show profile` by returning ['profile'].
export type ShellCommandCompleter =
  (params: ShellCommandAutocompleteParameters, args: string[]) => Promise<string[] | undefined>;

export interface TypeSignature {
  type: string;
  serverVersions?: [ string, string ];
  apiVersions?: [ number, number ];
  topologies?: Topologies[];
  returnsPromise?: boolean;
  deprecated?: boolean;
  returnType?: string | TypeSignature;
  attributes?: { [key: string]: TypeSignature };
  isDirectShellCommand?: boolean;
  shellCommandCompleter?: ShellCommandCompleter;
}

interface Signatures {
  [key: string]: TypeSignature;
}
const signaturesGlobalIdentifier = '@@@mdb.signatures@@@';
if (!(global as any)[signaturesGlobalIdentifier]) {
  (global as any)[signaturesGlobalIdentifier] = {};
}

const signatures: Signatures = (global as any)[signaturesGlobalIdentifier];
signatures.Document = { type: 'Document', attributes: {} };

type ClassSignature = {
  type: string;
  returnsPromise: boolean;
  deprecated: boolean;
  attributes: {
    [methodName: string]: {
      type: 'function';
      serverVersions: [ string, string ];
      apiVersions: [ number, number ];
      topologies: Topologies[];
      returnType: ClassSignature;
      returnsPromise: boolean;
      deprecated: boolean;
      platforms: ReplPlatform[];
      isDirectShellCommand: boolean;
      shellCommandCompleter?: ShellCommandCompleter;
    }
  };
};

type ClassHelp = {
  help: string;
  docs: string;
  attr: { name: string; description: string }[];
};

export const toIgnore = ['constructor', 'help', 'toJSON'];
function shellApiClassGeneric(constructor: Function, hasHelp: boolean): void {
  const className = constructor.name;
  const classHelpKeyPrefix = `shell-api.classes.${className}.help`;
  const classHelp: ClassHelp = {
    help: `${classHelpKeyPrefix}.description`,
    docs: `${classHelpKeyPrefix}.link`,
    attr: []
  };
  const classSignature: ClassSignature = {
    type: className,
    returnsPromise: constructor.prototype.returnsPromise || false,
    deprecated: constructor.prototype.deprecated || false,
    attributes: {}
  };

  const classAttributes = Object.getOwnPropertyNames(constructor.prototype);
  for (const propertyName of classAttributes) {
    const descriptor = Object.getOwnPropertyDescriptor(constructor.prototype, propertyName);
    const isMethod = descriptor?.value && typeof descriptor.value === 'function';
    if (
      !isMethod ||
      toIgnore.includes(propertyName) ||
      propertyName.startsWith('_')
    ) continue;
    let method: any = (descriptor as any).value;

    if ((constructor as any)[addSourceToResultsSymbol]) {
      method = wrapWithAddSourceToResult(method);
    }
    method = wrapWithApiChecks(method, className);

    method.serverVersions = method.serverVersions || ALL_SERVER_VERSIONS;
    method.apiVersions = method.apiVersions || ALL_API_VERSIONS;
    method.topologies = method.topologies || ALL_TOPOLOGIES;
    method.returnType = method.returnType || { type: 'unknown', attributes: {} };
    method.returnsPromise = method.returnsPromise || false;
    method.deprecated = method.deprecated || false;
    method.platforms = method.platforms || ALL_PLATFORMS;
    method.isDirectShellCommand = method.isDirectShellCommand || false;
    method.shellCommandCompleter = method.shellCommandCompleter || undefined;

    classSignature.attributes[propertyName] = {
      type: 'function',
      serverVersions: method.serverVersions,
      apiVersions: method.apiVersions,
      topologies: method.topologies,
      returnType: method.returnType === 'this' ? className : method.returnType,
      returnsPromise: method.returnsPromise,
      deprecated: method.deprecated,
      platforms: method.platforms,
      isDirectShellCommand: method.isDirectShellCommand,
      shellCommandCompleter: method.shellCommandCompleter
    };

    const attributeHelpKeyPrefix = `${classHelpKeyPrefix}.attributes.${propertyName}`;
    const attrHelp = {
      help: `${attributeHelpKeyPrefix}.example`,
      docs: `${attributeHelpKeyPrefix}.link`,
      attr: [
        { description: `${attributeHelpKeyPrefix}.description` }
      ]
    };
    const aHelp = new Help(attrHelp);
    method.help = (): Help => (aHelp);
    Object.setPrototypeOf(method.help, aHelp);

    classHelp.attr.push({
      name: propertyName,
      description: `${attributeHelpKeyPrefix}.description`
    });
    Object.defineProperty(constructor.prototype, propertyName, {
      ...descriptor,
      value: method
    });
  }

  let superClass = constructor.prototype;
  while ((superClass = Object.getPrototypeOf(superClass)) !== null) {
    if (superClass.constructor.name === 'ShellApiClass' || superClass.constructor === Array) {
      break;
    }
    const superClassHelpKeyPrefix = `shell-api.classes.${superClass.constructor.name}.help`;
    for (const propertyName of Object.getOwnPropertyNames(superClass)) {
      const descriptor = Object.getOwnPropertyDescriptor(superClass, propertyName);
      const isMethod = descriptor?.value && typeof descriptor.value === 'function';
      if (
        classAttributes.includes(propertyName) ||
        !isMethod ||
        toIgnore.includes(propertyName) ||
        propertyName.startsWith('_')
      ) continue;
      const method: any = (descriptor as any).value;

      classSignature.attributes[propertyName] = {
        type: 'function',
        serverVersions: method.serverVersions,
        apiVersions: method.apiVersions,
        topologies: method.topologies,
        returnType: method.returnType === 'this' ? className : method.returnType,
        returnsPromise: method.returnsPromise,
        deprecated: method.deprecated,
        platforms: method.platforms,
        isDirectShellCommand: method.isDirectShellCommand,
        shellCommandCompleter: method.shellCommandCompleter
      };

      const attributeHelpKeyPrefix = `${superClassHelpKeyPrefix}.attributes.${propertyName}`;

      classHelp.attr.push({
        name: propertyName,
        description: `${attributeHelpKeyPrefix}.description`
      });
    }
  }
  const help = new Help(classHelp);
  constructor.prototype.help = (): Help => (help);
  Object.setPrototypeOf(constructor.prototype.help, help);
  constructor.prototype[asPrintable] =
    constructor.prototype[asPrintable] ||
    ShellApiClass.prototype[asPrintable];
  addHiddenDataProperty(constructor.prototype, shellApiType, className);
  if (hasHelp) {
    signatures[className] = classSignature;
  }
}

/**
 * Marks a class as being a Shell API class including help information.
 */
export function shellApiClassDefault(constructor: Function): void {
  shellApiClassGeneric(constructor, true);
}

/**
 * Marks a class as being a Shell API class without help information
 */
export function shellApiClassNoHelp(constructor: Function): void {
  shellApiClassGeneric(constructor, false);
}

function markImplicitlyAwaited<T extends(...args: any) => Promise<any>>(orig: T): ((...args: Parameters<T>) => Promise<any>) {
  function wrapper(this: any, ...args: any[]) {
    const origResult = orig.call(this, ...args);
    return addHiddenDataProperty(origResult, Symbol.for('@@mongosh.syntheticPromise'), true);
  }
  Object.setPrototypeOf(wrapper, Object.getPrototypeOf(orig));
  Object.defineProperties(wrapper, Object.getOwnPropertyDescriptors(orig));
  return wrapper;
}

export { signatures };
/**
 * Marks the decorated method as being supported for the given range of server versions.
 * Server versions are given as `[min, max]` where both boundaries are **inclusive**.
 * If the version of the server the user is connected to is not inside the range, the method
 * will not be included in autocompletion.
 *
 * When a method is deprecated after a specific server version, the `versionArray` should include
 * this version as the `max` value.
 *
 * See also `ServerVersions.earliest` and `ServerVersions.latest`.
 *
 * @param versionArray An array of supported server versions
 */
export function serverVersions(versionArray: [ string, string ]): Function {
  return function(
    _target: any,
    _propertyKey: string,
    descriptor: PropertyDescriptor
  ): void {
    descriptor.value.serverVersions = versionArray;
  };
}

/**
 * Marks the decorated method as being supported for the given range of API versions.
 * API versions are given as `[version]` or `[min, max]`.
 * If the API version the user specified during connection is not inside the range, the method
 * will not be included in autocompletion.
 *
 * @param versionArray An array of supported API versions
 */
export function apiVersions(versionArray: [] | [ number ] | [ number, number ]): Function {
  return function(
    _target: any,
    _propertyKey: string,
    descriptor: PropertyDescriptor
  ): void {
    if (versionArray.length === 0) {
      versionArray = [ 0, 0 ];
    } else if (versionArray.length === 1) {
      versionArray = [ versionArray[0], Infinity ];
    }
    descriptor.value.apiVersions = versionArray;
  };
}

/**
 * Marks the decorated class/method as deprecated.
 * A deprecated method will not be included in autocompletion.
 *
 * Calling a deprecated method will automatically emit a telemetry event but
 * will **not** print an automatic deprecation warning (see `printDeprecationWarning`).
 *
 * **Important:** To exclude the method from autocompletion use `@serverVersions`.
 */
export function deprecated(_target: any, _propertyKey: string, descriptor: PropertyDescriptor): void {
  descriptor.value.deprecated = true;
}

/**
 * Marks the decorated method as only being available for the given topologies.
 * The method will not be included in autocomplete if the user is connected to a cluster
 * of a topology type that is not present in `topologiesArray`.
 *
 * @param topologiesArray The topologies for which the method is available
 */
export function topologies(topologiesArray: Topologies[]): Function {
  return function(
    _target: any,
    _propertyKey: string,
    descriptor: PropertyDescriptor
  ): void {
    descriptor.value.topologies = topologiesArray;
  };
}

export const nonAsyncFunctionsReturningPromises: string[] = []; // For testing.
/**
 * Marks the decorated method as having a synthetic promise return value that needs to be implicitly
 * awaited by the async rewriter.
 *
 * Note: a test will verify that the `nonAsyncFunctionsReturningPromises` is empty, i.e. **every**
 * method that is decorated with `@returnsPromise` must be an `async` method.
 */
export function returnsPromise(_target: any, _propertyKey: string, descriptor: PropertyDescriptor): void {
  const originalFunction = descriptor.value;
  originalFunction.returnsPromise = true;

  async function wrapper(this: any, ...args: any[]) {
    try {
      return await originalFunction.call(this, ...args);
    } finally {
      if (typeof setTimeout === 'function' && typeof setImmediate === 'function') {
        // Not all JS environments have setImmediate
        await new Promise(setImmediate);
      }
    }
  }
  Object.setPrototypeOf(wrapper, Object.getPrototypeOf(originalFunction));
  Object.defineProperties(wrapper, Object.getOwnPropertyDescriptors(originalFunction));
  descriptor.value = markImplicitlyAwaited(wrapper);

  if (originalFunction.constructor.name !== 'AsyncFunction') {
    nonAsyncFunctionsReturningPromises.push(originalFunction.name);
  }
}

/**
 * Marks the deocrated method as executable in the shell in a POSIX-shell-like
 * fashion, e.g. `show foo` which is translated into a call to `show('foo')`.
 */
export function directShellCommand(_target: any, _propertyKey: string, descriptor: PropertyDescriptor): void {
  descriptor.value.isDirectShellCommand = true;
}

/**
 * Marks the decorated method to provide a specific `completer` function to be
 * called for autocomplete.
 *
 * This can be used to provide autocompletion for POSIX-shell-like commands,
 * e.g. `show ...`.
 *
 * @param completer The completer to use for autocomplete
 */
export function shellCommandCompleter(completer: ShellCommandCompleter): Function {
  return function(
    _target: any,
    _propertyKey: string,
    descriptor: PropertyDescriptor
  ): void {
    descriptor.value.shellCommandCompleter = completer;
  };
}

/**
 * Marks the decorated method as returning a (resolved) value of the given Shell API type.
 * The type is given as string being the classname of the Shell API class.
 * Specify `'this'` in order to return a value of the methods surrounding class type.
 *
 * @param type The Shell API return type of the method
 */
export function returnType(type: string): Function {
  return function(
    _target: any,
    _propertyKey: string,
    descriptor: PropertyDescriptor
  ): void {
    descriptor.value.returnType = type;
  };
}

/**
 * Marks the constructor of the decorated class as being deprecated.
 *
 * Calling the constructor will automatically emit a telemetry event but
 * will **not** print an automatic deprecation warning (see `printDeprecationWarning`).
 */
export function classDeprecated(constructor: Function): void {
  constructor.prototype.deprecated = true;
}

/**
 * Marks the decorated method as only being supported on the given platforms.
 * @param platformsArray The platforms the method is supported on
 */
export function platforms(platformsArray: any[]): Function {
  return function(
    _target: any,
    _propertyKey: string,
    descriptor: PropertyDescriptor
  ): void {
    descriptor.value.platforms = platformsArray;
  };
}

/**
 * Marks the constructor of the decorated class as only being supported on the given platforms.
 * @param platformsArray The platforms the method is supported on
 */
export function classPlatforms(platformsArray: any[]): Function {
  return function(constructor: Function): void {
    constructor.prototype.platforms = platformsArray;
  };
}

/**
 * Marks the decorated class that for all methods in the class additional
 * source information of the call will be added to the calls returned result.
 */
export function addSourceToResults(constructor: Function): void {
  (constructor as any)[addSourceToResultsSymbol] = true;
}
