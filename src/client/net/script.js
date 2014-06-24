// Copyright 2014 Google Inc. All rights reserved.
//
// Use of this source code is governed by The MIT License.
// See the LICENSE file for details.

/**
 * @fileoverview Functions for dynamically loading scripts without blocking.
 *
 * Provides asynchronous loading and dependency management, loosely similar to
 * $script.js {@link https://github.com/ded/script.js/} but with enhancements.
 * Designed to be built as both a standlone bootstrap script loader in the
 * document head and also built as part of the main SPF code. When both the
 * bootstrap and main code is loaded on the same page, the main code extends
 * the bootstrap code for seamless script loading.
 *
 * Single script:
 * spf.net.script.load(url, function() {
 *   // url is loaded
 * });
 *
 * Multiple scripts:
 * spf.net.script.load([url1, url2], function() {
 *   // url1 and url2 are loaded
 * });
 *
 * Named script(s) and readiness:
 * spf.net.script.load(url, 'name');
 * spf.net.script.ready('name', function() {
 *   // url is loaded
 * });
 *
 * @author nicksay@google.com (Alex Nicksay)
 */

goog.provide('spf.net.script');

goog.require('spf.array');
goog.require('spf.debug');
goog.require('spf.net.resource');
goog.require('spf.net.resource.urls');
goog.require('spf.pubsub');
goog.require('spf.string');
goog.require('spf.tracing');


/**
 * Loads one or more scripts asynchronously and optionally defines a name to
 * use for dependency management and unloading.  See {@link #ready} to wait
 * for named scripts to be loaded and {@link #unload} to remove previously
 * loaded scripts.
 *
 * - Subsequent calls to load the same URL will not reload the script.  To
 *   reload a script, unload it first with {@link #unload}.
 *
 * - A callback can be specified to execute once the script has loaded.  The
 *   callback will be executed each time, even if the script is not reloaded.
 *
 * - A name can be specified to identify the same script at different URLs.
 *   (For example, "main-A.js" and "main-B.js" are both "main".)  If a name
 *   is specified, all other scripts with the same name will be unloaded
 *   before the callback is executed.  This allows switching between
 *   versions of the same script at different URLs.
 *
 * @param {string|Array.<string>} urls One or more URLs of scripts to load.
 * @param {(string|Function)=} opt_nameOrFn Name to identify the script(s)
 *     or callback function to execute when the script is loaded.
 * @param {Function=} opt_fn Callback function to execute when the script is
 *     loaded.
 */
spf.net.script.load = function(urls, opt_nameOrFn, opt_fn) {
  var type = spf.net.resource.Type.JS;

  // Convert to an array if needed.
  urls = spf.array.toArray(urls);

  // Determine if a name was provided with 2 or 3 arguments.
  var withName = spf.string.isString(opt_nameOrFn);
  var name = /** @type {string} */ (withName ? opt_nameOrFn : '');
  var callback = /** @type {Function} */ (withName ? opt_fn : opt_nameOrFn);
  spf.debug.debug('script.load', urls, name);

  // After the scripts are loaded, execute the callback by default.
  var done = callback;

  // If a name is provided with different URLs, then also unload the previous
  // versions after the scripts are loaded.
  //
  // NOTE: When built for the bootloader, automatic unloading of scripts is not
  // supported.  If someone is attempting to load a new version of a script
  // before loading the main SPF code, then this should be an error.  Automatic
  // unloading of scripts is primarily intended for navigation between versions.
  if (!SPF_BOOTLOADER) {
    if (name) {
      var loaded = spf.array.every(urls, spf.net.script.loaded_);
      var previous = spf.net.resource.urls.get(type, name);
      // If loading new scripts for a name, handle unloading previous ones.
      if (!loaded && previous) {
        spf.dispatch('jsbeforeunload', {'name': name, 'urls': previous});
        spf.net.resource.urls.clear(type, name);
        done = function() {
          spf.net.script.unload_(name, previous);
          callback && callback();
        };
      }
    }
  }

  var pseudonym = name || '^' + urls.sort().join('^');
  // Associate the scripts with the name (or pseudonym) to allow unloading.
  spf.net.resource.urls.set(type, pseudonym, urls);
  // Subscribe the callback to execute when all urls are loaded.
  var topic = spf.net.script.prefix_(pseudonym);
  spf.debug.debug('  subscribing', topic, done);
  spf.pubsub.subscribe(topic, done);
  // Start asynchronously loading all the scripts.
  spf.array.each(urls, function(url) {
    // If a status exists, the script is already loading or loaded.
    if (spf.net.script.exists_(url)) {
      spf.net.script.check();
    } else {
      var el = spf.net.script.get(url, spf.net.script.check);
      if (name) {
        el.setAttribute('name', name);
      }
    }
  });
};


/**
 * Unloads scripts identified by name.  See {@link #load}.
 *
 * NOTE: Unloading a script will prevent execution of ALL pending callbacks
 * but is NOT guaranteed to stop the browser loading a pending URL.
 *
 * @param {string} name The name.
 */
spf.net.script.unload = function(name) {
  spf.debug.warn('script.unload', name);
  var type = spf.net.resource.Type.JS;
  // Convert to an array if needed.
  var urls = spf.net.resource.urls.get(type, name) || [];
  spf.net.resource.urls.clear(type, name);
  spf.net.script.unload_(name, urls);
};


/**
 * See {@link unload}.
 *
 * @param {string} name The name.
 * @param {Array.<string>} urls The URLs.
 * @private
*/
spf.net.script.unload_ = function(name, urls) {
  var type = spf.net.resource.Type.JS;
  if (urls.length) {
    spf.debug.warn('  > script.unload', urls);
    spf.dispatch('jsunload', {'name': name, 'urls': urls});
    spf.array.each(urls, function(url) {
      spf.net.resource.destroy(type, url);
    });
  }
};


/**
 * Discovers existing scripts in the document and registers them as loaded.
 */
spf.net.script.discover = function() {
  spf.debug.debug('script.discover');
  var type = spf.net.resource.Type.JS;
  var els = spf.net.resource.discover(type);
  spf.array.each(els, function(el) {
    var name = el.getAttribute('name');
    if (name) {
      spf.net.resource.urls.set(type, name, [el.src]);
    }
    spf.debug.debug('  found', el.src, name);
  });
};


/**
 * Unconditionally loads a script by dynamically creating an element and
 * appending it to the document without regard for dependencies or whether it
 * has been loaded before.  A script directly loaded by this method cannot
 * be unloaded by name.  Compare to {@link #load}.
 *
 * @param {string} url The URL of the script to load.
 * @param {Function=} opt_fn Function to execute when loaded.
 * @return {Element} The newly created element.
 */
spf.net.script.get = function(url, opt_fn) {
  var type = spf.net.resource.Type.JS;
  return spf.net.resource.create(type, url, opt_fn);
};


/**
 * Waits for one or more scripts identified by name to be loaded and executes
 * the callback function.  See {@link #load} or {@link #done} to define names.
 *
 * @param {string|Array.<string>} names One or more names.
 * @param {Function=} opt_fn Callback function to execute when the
 *     scripts have loaded.
 * @param {Function=} opt_require Callback function to execute if names
 *     are specified that have not yet been defined/loaded.
 */
spf.net.script.ready = function(names, opt_fn, opt_require) {
  // Convert to an array if needed.
  names = spf.array.toArray(names);
  spf.debug.debug('script.ready', names);
  var type = spf.net.resource.Type.JS;

  // Find unknown names.
  var unknown = [];
  spf.array.each(names, function(name) {
    if (name && !spf.net.resource.urls.get(type, name)) {
      unknown.push(name);
    }
  });

  // Check if all urls for the names are loaded.
  var known = !unknown.length;
  if (opt_fn) {
    var ready = spf.array.every(names, spf.net.script.allLoaded_);
    if (known && ready) {
      // If ready, execute the callback.
      opt_fn();
    } else {
      // Otherwise, wait for them to be loaded.
      var topic = spf.net.script.prefix_(names.sort().join('|'));
      spf.debug.debug('  subscribing', topic);
      spf.pubsub.subscribe(topic, opt_fn);
    }
  }
  // If provided, call the require function to allow lazy-loading.
  if (opt_require && !known) {
    opt_require(unknown);
  }
};


/**
 * Notifies any waiting callbacks that {@code name} has completed loading.
 * Use with {@link #ready} for arbitrary readiness not directly tied to scripts.
 *
 * @param {string} name The ready name.
 */
spf.net.script.done = function(name) {
  var type = spf.net.resource.Type.JS;
  spf.net.resource.urls.set(type, name, []);  // No associated URLs.
  spf.net.script.check();
};


/**
 * "Ignores" a script load by canceling execution of a pending callback.
 *
 * Stops waiting for one or more scripts identified by name to be loaded and
 * cancels the pending callback execution.  The callback must have been
 * registered by {@link #load} or {@link #ready}.  If the callback was
 * registered by {@link #ready} and more than one name was provided, the same
 * names must be used here.
 *
 * @param {string|Array.<string>} names One or more names.
 * @param {Function} fn Callback function to cancel.
 */
spf.net.script.ignore = function(names, fn) {
  // Convert to an array if needed.
  names = spf.array.toArray(names);
  spf.debug.debug('script.ignore', names);
  var topic = spf.net.script.prefix_(names.sort().join('|'));
  spf.debug.debug('  unsubscribing', topic);
  spf.pubsub.unsubscribe(topic, fn);
};


/**
 * Recursively loads scripts identified by name, first loading
 * any dependendent scripts.  Use {@link #declare} to define dependencies.
 *
 * @param {string|Array.<string>} names One or more names.
 * @param {Function=} opt_fn Callback function to execute when the
 *     scripts have loaded.
 */
spf.net.script.require = function(names, opt_fn) {
  spf.debug.debug('script.require', names);
  var type = spf.net.resource.Type.JS;

  // When built for the bootloader, automatic unloading of scripts is not
  // supported.  If someone is attempting to load a new version of a script
  // before loading the main SPF code, then this should be an error.  Automatic
  // unloading of scripts is primarily intended for navigation between versions.
  if (!SPF_BOOTLOADER) {
    // Convert to an array if needed.
    names = spf.array.toArray(names);
    spf.array.each(names, function(name) {
      if (name) {
        var current = spf.net.script.urls_[name] || name;
        var different = spf.net.script.anyDifferent_(name, current);
        if (different) {
          spf.net.script.unrequire(name);
        }
      }
    });
  }

  spf.net.script.ready(names, opt_fn, spf.net.script.require_);
};


/**
 * See {@link #require}.
 *
 * @param {Array.<string>} names The names.
 * @private
 */
spf.net.script.require_ = function(names) {
  // Iterate and check if there are declared dependencies.
  // If so, check if the deps are ready and if not recurse.
  // If not, load the scripts for that name.
  spf.array.each(names, function(name) {
    var deps = spf.net.script.deps_[name];
    var urls = spf.net.script.urls_[name] || name;
    var next = function() {
      spf.net.script.load(urls, name);
    };
    if (deps) {
      spf.net.script.require(deps, next);
    } else {
      next();
    }
  });
};


/**
 * Recursively unloads scripts identified by name, first unloading
 * any dependendent scripts.  Use {@link #declare} to define dependencies.
 *
 * @param {string|Array.<string>} names One or more names.
 */
spf.net.script.unrequire = function(names) {
  spf.debug.debug('script.unrequire', names);
  // Convert to an array if needed.
  names = spf.array.toArray(names);
  spf.array.each(names, function(name) {
    var descendants = [];
    for (var dep in spf.net.script.deps_) {
      var list = spf.net.script.deps_[dep];
      list = spf.array.toArray(list);
      spf.array.each(list, function(l) {
        if (l == name) {
          descendants.push(dep);
        }
      });
    }
    spf.array.each(descendants, function(descend) {
      spf.net.script.unrequire(descend);
    });
    spf.net.script.unload(name);
  });
};


/**
 * Executes any pending callbacks possible by checking if all pending
 * urls for a name have loaded.
 */
spf.net.script.check = function() {
  spf.debug.debug('script.check');
  var prefix = spf.net.script.prefix_('');
  for (var topic in spf.pubsub.subscriptions) {
    if (topic.indexOf(prefix) == 0) {
      var names = topic.substring(prefix.length).split('|');
      var ready = spf.array.every(names, spf.net.script.allLoaded_);
      spf.debug.debug(' ', topic, '->', names, '=', ready);
      if (ready) {
        spf.debug.debug('  publishing', topic);
        // Because check evaluates the pubsub.subscriptions array to determine
        // if urls for names are loaded, there is a potential subscribe/publish
        // infinite loop:
        //     require_ -> load (subscribe) -> check (publish) ->
        //     load (subscribe) -> <loop forever> ...
        // To avoid this, use flush instead of publish + clear to ensure that
        // previously subscribed functions are removed before execution:
        //     require_ -> load (subscribe) -> check (flush) -> <no loop>
        spf.pubsub.flush(topic);
      }
    }
  }
};


/**
 * Prefetchs one or more scripts; the scripts will be requested but not loaded.
 * Use to prime the browser cache and avoid needing to request the script when
 * subsequently loaded.  See {@link #load}.
 *
 * @param {string|Array.<string>} urls One or more URLs of scripts to prefetch.
 */
spf.net.script.prefetch = function(urls) {
  var type = spf.net.resource.Type.JS;
  // Convert to an array if needed.
  urls = spf.array.toArray(urls);
  spf.array.each(urls, function(url) {
    spf.net.resource.prefetch(type, url);
  });
};


/**
 * Evaluates script text.  A callback can be specified to execute once
 * evaluation is done.
 *
 * @param {string} text The text of the script.
 * @param {Function=} opt_callback Callback function to execute when the
 *     script is loaded.
 * @return {undefined}
 */
spf.net.script.eval = function(text, opt_callback) {
  text = spf.string.trim(text);
  if (text) {
    if (window.execScript) {
      // For IE, reach global scope using execScript to avoid a bug where
      // indirect eval is treated as direct eval.
      window.execScript(text);
    } else if (spf.string.startsWith(text, 'use strict', 1)) {
      // For strict mode, reach global scope using the slower script injection
      // method.
      var scriptEl = document.createElement('script');
      scriptEl.text = text;
      // Place the scripts in the head instead of the body to avoid errors when
      // called from the head in the first place.
      var targetEl = document.getElementsByTagName('head')[0] || document.body;
      targetEl.appendChild(scriptEl);
      targetEl.removeChild(scriptEl);
    } else {
      // Otherwise, use indirect eval to reach global scope.
      (0, eval)(text);
    }
  }
  if (opt_callback) {
    opt_callback();
  }
};


/**
 * Sets the dependency map and optional URL map used when requiring scripts.
 * See {@link #require}.
 *
 * @param {Object.<(string|Array.<string>)>} deps The dependency map.
 * @param {Object.<(string|Array.<string>)>=} opt_urls The optional URL map.
 */
spf.net.script.declare = function(deps, opt_urls) {
  if (deps) {
    for (var name in deps) {
      spf.net.script.deps_[name] = deps[name];
    }
    if (opt_urls) {
      for (var name in opt_urls) {
        spf.net.script.urls_[name] = opt_urls[name];
      }
    }
  }
};


/**
 * Sets the path prefix or replacement map to use when resolving relative URLs.
 *
 * Note: The order in which replacements are made is not guaranteed.
 *
 * @param {string|Object.<string>} paths The paths.
 */
spf.net.script.path = function(paths) {
  var type = spf.net.resource.Type.JS;
  spf.net.resource.path(type, paths);
};


/**
 * Prefix a name to avoid conflicts.
 *
 * @param {?} name The name
 * @return {string} The prefixed name.
 * @private
 */
spf.net.script.prefix_ = function(name) {
  var type = spf.net.resource.Type.JS;
  return spf.net.resource.prefix(type, name);
};


/**
 * Checks to see if a script exists.
 * (If a URL is loading or loaded, then it exists.)
 *
 * @param {string} url The URL.
 * @return {boolean} Whether the URL is loaded.
 * @private
 */
spf.net.script.exists_ = function(url) {
  var type = spf.net.resource.Type.JS;
  return spf.net.resource.exists(type, url);
};


/**
 * Checks to see if a script has been loaded.
 * (Falsey URL values (e.g. null or an empty string) are always "loaded".)
 *
 * @param {string} url The URL.
 * @return {boolean} Whether the URL is loaded.
 * @private
 */
spf.net.script.loaded_ = function(url) {
  var type = spf.net.resource.Type.JS;
  return spf.net.resource.loaded(type, url);
};


/**
 * Checks to see if all urls for a dependency have been loaded.
 * (Falsey dependency names (e.g. null or an empty string) are always "loaded".)
 *
 * @param {string} name The dependency name.
 * @return {boolean}
 * @private
 */
spf.net.script.allLoaded_ = function(name) {
  var type = spf.net.resource.Type.JS;
  var urls = spf.net.resource.urls.get(type, name);
  return !name || (!!urls && spf.array.every(urls, spf.net.script.loaded_));
};


/**
 * Checks to see if urls for a dependency are different.
 * (If none are already loaded, then they are not different.)
 *
 * @param {string} name The dependency name.
 * @param {string|Array.<string>} updated One or more new/updated URLs to check.
 * @return {boolean}
 * @private
 */
spf.net.script.anyDifferent_ = function(name, updated) {
  var type = spf.net.resource.Type.JS;
  var urls = spf.net.resource.urls.get(type, name);
  if (urls) {
    updated = spf.array.toArray(updated);
    return !spf.array.every(urls, function(url, i) {
      return urls[i] == spf.net.resource.canonicalize(type, updated[i]);
    });
  } else {
    return false;
  }
};


/**
 * Map of dependencies.
 * @type {!Object.<(string|Array.<string>)>}
 * @private
 */
spf.net.script.deps_ = {};
// When built for the bootloader, unconditionally set the map in state.
if (SPF_BOOTLOADER) {
  spf.state.set(spf.net.script.DEPS_KEY, spf.net.script.deps_);
} else {
  if (!spf.state.has(spf.net.script.DEPS_KEY)) {
    spf.state.set(spf.net.script.DEPS_KEY, {});
  }
  spf.net.script.deps_ = /** @type {!Object.<(string|Array.<string>)>} */ (
      spf.state.get(spf.net.script.DEPS_KEY));
}


/**
 * Map of urls for dependencies.
 * @type {!Object.<(string|Array.<string>)>}
 * @private
 */
spf.net.script.urls_ = {};
// When built for the bootloader, unconditionally set the map in state.
if (SPF_BOOTLOADER) {
  spf.state.set(spf.net.script.URLS_KEY, spf.net.script.urls_);
} else {
  if (!spf.state.has(spf.net.script.URLS_KEY)) {
    spf.state.set(spf.net.script.URLS_KEY, {});
  }
  spf.net.script.urls_ = /** @type {!Object.<(string|Array.<string>)>} */ (
      spf.state.get(spf.net.script.URLS_KEY));
}


/**
 * Key used to store and retrieve script dependencies in state.
 * @type {string}
 * @const
 */
spf.net.script.DEPS_KEY = 'js-d';


/**
 * Key used to store and retrieve script urls in state.
 * @type {string}
 * @const
 */
spf.net.script.URLS_KEY = 'js-u';


if (spf.tracing.ENABLED) {
  (function() {
    spf.net.script.load = spf.tracing.instrument(
        spf.net.script.load, 'spf.net.script.load');
    spf.net.script.unload = spf.tracing.instrument(
        spf.net.script.unload, 'spf.net.script.unload');
    spf.net.script.unload_ = spf.tracing.instrument(
        spf.net.script.unload_, 'spf.net.script.unload_');
    spf.net.script.discover = spf.tracing.instrument(
        spf.net.script.discover, 'spf.net.script.discover');
    spf.net.script.get = spf.tracing.instrument(
        spf.net.script.get, 'spf.net.script.get');
    spf.net.script.ready = spf.tracing.instrument(
        spf.net.script.ready, 'spf.net.script.ready');
    spf.net.script.done = spf.tracing.instrument(
        spf.net.script.done, 'spf.net.script.done');
    spf.net.script.ignore = spf.tracing.instrument(
        spf.net.script.ignore, 'spf.net.script.ignore');
    spf.net.script.require = spf.tracing.instrument(
        spf.net.script.require, 'spf.net.script.require');
    spf.net.script.require_ = spf.tracing.instrument(
        spf.net.script.require_, 'spf.net.script.require_');
    spf.net.script.unrequire = spf.tracing.instrument(
        spf.net.script.unrequire, 'spf.net.script.unrequire');
    spf.net.script.check = spf.tracing.instrument(
        spf.net.script.check, 'spf.net.script.check');
    spf.net.script.prefetch = spf.tracing.instrument(
        spf.net.script.prefetch, 'spf.net.script.prefetch');
    spf.net.script.eval = spf.tracing.instrument(
        spf.net.script.eval, 'spf.net.script.eval');
    spf.net.script.declare = spf.tracing.instrument(
        spf.net.script.declare, 'spf.net.script.declare');
    spf.net.script.path = spf.tracing.instrument(
        spf.net.script.path, 'spf.net.script.path');
    spf.net.script.prefix_ = spf.tracing.instrument(
        spf.net.script.prefix_, 'spf.net.script.prefix_');
    spf.net.script.exists_ = spf.tracing.instrument(
        spf.net.script.exists_, 'spf.net.script.exists_');
    spf.net.script.loaded_ = spf.tracing.instrument(
        spf.net.script.loaded_, 'spf.net.script.loaded_');
    spf.net.script.allLoaded_ = spf.tracing.instrument(
        spf.net.script.allLoaded_, 'spf.net.script.allLoaded_');
    spf.net.script.anyDifferent_ = spf.tracing.instrument(
        spf.net.script.anyDifferent_, 'spf.net.script.anyDifferent_');
  })();
}
