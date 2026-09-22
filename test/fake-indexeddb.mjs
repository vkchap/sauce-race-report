/*
 * An in-memory IndexedDB, for the tests.
 *
 * WHAT THIS FILE DOES: stands in for window.indexedDB so src/store.mjs can be exercised in plain
 * node, where there is no IndexedDB and no npm package can be installed. It covers only the subset
 * store.mjs uses, and fails loudly on anything else:
 *
 *   indexedDB.open(name, version)       request with onupgradeneeded, onsuccess, onerror, onblocked
 *   db.objectStoreNames.contains(name)
 *   db.createObjectStore(name)          out-of-line keys only
 *   db.transaction(name, mode)          'readonly' or 'readwrite', one object store
 *   db.close(), db.onversionchange
 *   tx.objectStore(name).get(key)       request with onsuccess, result
 *   tx.objectStore(name).put(value, key)
 *   tx.objectStore(name).delete(key)
 *   tx.objectStore(name).getAllKeys()   no range, keys in sorted order
 *   tx.abort()
 *   tx.oncomplete, tx.onerror, tx.onabort, tx.error
 *
 * The parts of the real thing that matter to the mod are kept: every request and every
 * transaction finishes asynchronously, a transaction is all or nothing (an aborted one too), a
 * readonly transaction refuses a write, a transaction that has finished refuses new requests, and
 * values are stored as structured clones. Switches make it fail the ways a real one can:
 * `throwOnOpen` (open throws, as it does where storage is blocked), `failOpen` (open reports an
 * error), `hangOpens` (that many opens never answer at all) and `limit` (a readwrite transaction
 * that would take the stored characters past it aborts with QuotaExceededError). `failWrites`
 * aborts every readwrite transaction.
 */

function later(fn) {
    setTimeout(fn, 0);
}

function domError(name, message) {
    const e = new Error(message || name);
    e.name = name;
    return e;
}

function sizeOf(value) {
    return typeof value === 'string' ? value.length : JSON.stringify(value ?? null).length;
}


class FakeRequest {
    constructor() {
        this.result = undefined;
        this.error = null;
        this.onsuccess = null;
        this.onerror = null;
        this.onupgradeneeded = null;
        this.onblocked = null;
    }
}


class FakeObjectStore {
    constructor(tx, name) {
        this.tx = tx;
        this.name = name;
    }

    _request(op) {
        if (this.tx.finished) {
            throw domError('TransactionInactiveError', 'the transaction has finished');
        }
        const req = new FakeRequest();
        this.tx.ops.push({...op, req});
        return req;
    }

    get(key) {
        return this._request({type: 'get', key});
    }

    put(value, key) {
        if (this.tx.mode !== 'readwrite') {
            throw domError('ReadOnlyError', 'the transaction is readonly');
        }
        if (key === undefined) {
            throw domError('DataError', 'this fake stores out-of-line keys only');
        }
        return this._request({type: 'put', key, value: structuredClone(value)});
    }

    delete(key) {
        if (this.tx.mode !== 'readwrite') {
            throw domError('ReadOnlyError', 'the transaction is readonly');
        }
        return this._request({type: 'delete', key});
    }

    getAllKeys() {
        return this._request({type: 'getAllKeys'});
    }
}


class FakeTransaction {
    constructor(db, name, mode) {
        this.db = db;
        this.name = name;
        this.mode = mode;
        this.ops = [];
        this.finished = false;
        this.error = null;
        this.oncomplete = null;
        this.onerror = null;
        this.onabort = null;
        this.aborted = false;
        later(() => this._run());
    }

    /* Nothing the transaction did is kept, and it ends with onabort. */
    abort() {
        if (this.finished && !this.aborted) {
            throw domError('InvalidStateError', 'the transaction has finished');
        }
        this.aborted = true;
    }

    objectStore(name) {
        if (name !== this.name) {
            throw domError('NotFoundError', `${name} is not in this transaction`);
        }
        return new FakeObjectStore(this, name);
    }

    _run() {
        const factory = this.db.factory;
        const live = this.db.stores.get(this.name);
        // Copy on write, so an aborted transaction leaves nothing behind.
        const work = new Map(live);
        for (let i = 0; i < this.ops.length && !this.aborted; i++) {
            const op = this.ops[i];
            if (op.type === 'get') {
                op.req.result = work.has(op.key) ? structuredClone(work.get(op.key)) : undefined;
            } else if (op.type === 'getAllKeys') {
                op.req.result = Array.from(work.keys()).sort();
            } else if (op.type === 'put') {
                work.set(op.key, op.value);
            } else {
                work.delete(op.key);
            }
            // A callback can queue more requests, which run in this same transaction.
            if (op.req.onsuccess) {
                op.req.onsuccess({target: op.req});
            }
        }
        this.finished = true;
        if (this.aborted) {
            this.error = domError('AbortError', 'the transaction was aborted');
            if (this.onabort) {
                this.onabort({target: this});
            }
            return;
        }
        if (this.mode === 'readwrite') {
            factory.writeTransactions++;
            let failure = null;
            if (factory.failWrites) {
                failure = domError('UnknownError', 'writes are failing');
            } else if (factory.limit !== Infinity) {
                let n = 0;
                for (const db of factory.databases.values()) {
                    for (const [storeName, store] of db.stores) {
                        const m = (db === this.db && storeName === this.name) ? work : store;
                        for (const [k, v] of m) {
                            n += String(k).length + sizeOf(v);
                        }
                    }
                }
                if (n > factory.limit) {
                    failure = domError('QuotaExceededError', 'the fake quota was exceeded');
                }
            }
            if (failure) {
                this.error = failure;
                if (this.onerror) {
                    this.onerror({target: this});
                }
                if (this.onabort) {
                    this.onabort({target: this});
                }
                return;
            }
            this.db.stores.set(this.name, work);
        }
        if (this.oncomplete) {
            this.oncomplete({target: this});
        }
    }
}


class FakeDatabase {
    constructor(factory, name) {
        this.factory = factory;
        this.name = name;
        this.version = 0;
        this.stores = new Map();
        this.closed = false;
        this.onversionchange = null;
        const stores = this.stores;
        this.objectStoreNames = {
            contains: n => stores.has(n),
            get length() {
                return stores.size;
            },
        };
    }

    createObjectStore(name, options) {
        if (options && (options.keyPath != null || options.autoIncrement)) {
            throw domError('NotSupportedError', 'this fake stores out-of-line keys only');
        }
        if (this.stores.has(name)) {
            throw domError('ConstraintError', `${name} already exists`);
        }
        this.stores.set(name, new Map());
    }

    transaction(name, mode = 'readonly') {
        if (this.closed) {
            throw domError('InvalidStateError', 'the database connection is closed');
        }
        if (Array.isArray(name)) {
            if (name.length !== 1) {
                throw domError('NotSupportedError', 'this fake takes one object store per transaction');
            }
            name = name[0];
        }
        if (!this.stores.has(name)) {
            throw domError('NotFoundError', `no object store called ${name}`);
        }
        if (mode !== 'readonly' && mode !== 'readwrite') {
            throw domError('TypeError', `bad mode ${mode}`);
        }
        return new FakeTransaction(this, name, mode);
    }

    close() {
        this.closed = true;
    }
}


export class FakeIndexedDB {
    constructor({throwOnOpen = false, failOpen = false, failWrites = false, limit = Infinity,
                 hangOpens = 0} = {}) {
        this.hangOpens = hangOpens;
        this.throwOnOpen = throwOnOpen;
        this.failOpen = failOpen;
        this.failWrites = failWrites;
        this.limit = limit;
        this.databases = new Map();
        this.writeTransactions = 0;
    }

    open(name, version = 1) {
        if (this.throwOnOpen) {
            throw domError('SecurityError', 'IndexedDB is not allowed here');
        }
        const req = new FakeRequest();
        if (this.hangOpens > 0) {
            // Never answers, the way an open can hang while something else holds the disk.
            this.hangOpens--;
            return req;
        }
        later(() => {
            if (this.failOpen) {
                req.error = domError('UnknownError', 'the database could not be opened');
                if (req.onerror) {
                    req.onerror({target: req});
                }
                return;
            }
            let db = this.databases.get(name);
            if (!db) {
                db = new FakeDatabase(this, name);
                this.databases.set(name, db);
            }
            db.closed = false;
            req.result = db;
            if (version > db.version) {
                const oldVersion = db.version;
                db.version = version;
                if (req.onupgradeneeded) {
                    req.onupgradeneeded({target: req, oldVersion, newVersion: version});
                }
            }
            if (req.onsuccess) {
                req.onsuccess({target: req});
            }
        });
        return req;
    }

    /* Every key and value in every database, for the tests to look at. */
    dump(name) {
        const db = this.databases.get(name);
        const out = new Map();
        if (db) {
            for (const store of db.stores.values()) {
                for (const [k, v] of store) {
                    out.set(k, v);
                }
            }
        }
        return out;
    }
}
