"use strict";
/// <reference path="uglify-js.d.ts" />
function isRequire(symbolDef) {
    return (symbolDef != null &&
        symbolDef.undeclared &&
        symbolDef.global &&
        symbolDef.name === "require");
}
function isPromise(symbolDef) {
    return (symbolDef != null &&
        symbolDef.undeclared &&
        symbolDef.global &&
        symbolDef.name === "Promise");
}
function isReexport(symbolDef) {
    return (symbolDef != null &&
        symbolDef.undeclared &&
        symbolDef.global &&
        symbolDef.name === "__exportStar");
}
function detectRequireCall(node) {
    if (node instanceof AST_Call) {
        let call = node;
        if (call.args.length === 1 &&
            call.expression instanceof AST_SymbolRef &&
            isRequire(call.expression.thedef)) {
            let arg = call.args[0];
            if (arg instanceof AST_String) {
                return arg.value;
            }
        }
    }
    return undefined;
}
//Detect this pattern and success return require const parameter 
//Promise.resolve().then(function() {
//    return require("./lib");
//})
//Because this pattern is generated by TypeScript compiler when using: import("./lib")
function detectLazyRequireCall(node) {
    if ((node instanceof AST_Call) && (node.args != null) && (node.args.length === 1)) {
        let then = node.expression;
        if ((then instanceof AST_Dot) && (then.property === "then")) {
            let resolveCall = then.expression;
            if ((resolveCall instanceof AST_Call) && ((resolveCall.args == null) || (resolveCall.args.length === 0))) {
                let resolveExpr = resolveCall.expression;
                if ((resolveExpr instanceof AST_Dot) && (resolveExpr.property === "resolve")) {
                    let promiseRef = resolveExpr.expression;
                    if (!(promiseRef instanceof AST_SymbolRef) || (!isPromise(promiseRef.thedef)))
                        return undefined;
                }
                else
                    return undefined;
            }
            else
                return undefined;
        }
        else
            return undefined;
        let argumentFunction = node.args[0];
        if ((argumentFunction instanceof AST_Function) && (argumentFunction.argnames == null || argumentFunction.argnames.length === 0) && (argumentFunction.body != null)) {
            let body = argumentFunction.body;
            if (body.length === 1) {
                let returnStatement = body[0];
                if (returnStatement instanceof AST_Return)
                    return detectRequireCall(returnStatement.value);
            }
        }
    }
    return undefined;
}
function isExports(node) {
    if (node instanceof AST_SymbolRef) {
        let thedef = node.thedef;
        // thedef could be null because it could be already renamed/cloned ref
        if (thedef != null &&
            thedef.global &&
            thedef.undeclared &&
            thedef.name === "exports")
            return true;
    }
    return false;
}
function matchPropKey(propAccess) {
    let name = propAccess.property;
    if (name instanceof AST_String) {
        name = name.value;
    }
    if (typeof name === "string") {
        return name;
    }
    return undefined;
}
function patternAssignExports(node) {
    if (node instanceof AST_Assign) {
        let assign = node;
        if (assign.operator === "=") {
            if (assign.left instanceof AST_PropAccess) {
                let propAccess = assign.left;
                if (isExports(propAccess.expression)) {
                    let name = matchPropKey(propAccess);
                    if (name !== undefined) {
                        return {
                            name,
                            value: assign.right
                        };
                    }
                }
            }
        }
    }
    return undefined;
}
function patternDefinePropertyExportsEsModule(call) {
    //Object.defineProperty(exports, "__esModule", { value: true });
    if (call.args.length === 3 && isExports(call.args[0])) {
        if (call.expression instanceof AST_PropAccess) {
            let exp = call.expression;
            if (matchPropKey(exp) === "defineProperty") {
                if (exp.expression instanceof AST_SymbolRef) {
                    let symb = exp.expression;
                    if (symb.name === "Object")
                        return true;
                }
            }
        }
    }
    return false;
}
function isConstantSymbolRef(node) {
    if (node instanceof AST_SymbolRef) {
        let def = node.thedef;
        if (def.undeclared)
            return false;
        if (def.orig.length !== 1)
            return false;
        if (def.orig[0] instanceof AST_SymbolDefun)
            return true;
    }
    return false;
}
function promoteToIndependentLazyBundle(file, bundleName, cache) {
    if (file.partOfBundle == bundleName)
        return;
    if (file.partOfBundle == "")
        return;
    file.partOfBundle = bundleName;
    file.requires.forEach(r => {
        promoteToIndependentLazyBundle(cache[r.toLowerCase()], bundleName, cache);
    });
}
function markRequiredAs(file, requiredAs, cache) {
    if (file.partOfBundle !== requiredAs && file.partOfBundle !== "") {
        if (requiredAs === "") {
            file.partOfBundle = "";
        }
        else {
            // imported from 2 lazy bundles => promote to independent lazy bundle
            promoteToIndependentLazyBundle(file, file.name.toLowerCase(), cache);
        }
    }
}
function check(name, order, visited, cache, requiredAs) {
    let cached = cache[name.toLowerCase()];
    if (cached !== undefined)
        return cached;
    let fileContent = bb.readContent(name);
    //console.log("============== START " + name);
    //console.log(fileContent);
    let ast = parse(fileContent);
    //console.log(ast.print_to_string({ beautify: true }));
    ast.figure_out_scope();
    cached = {
        name,
        ast,
        requires: [],
        lazyRequires: [],
        difficult: false,
        partOfBundle: requiredAs,
        selfexports: [],
        exports: undefined,
        pureFuncs: Object.create(null)
    };
    const cachedName = name.toLowerCase();
    cache[cachedName] = cached;
    let pureMatch = fileContent.match(/^\/\/ PureFuncs:.+/gm);
    if (pureMatch) {
        pureMatch.forEach(m => {
            m
                .toString()
                .substr(m.indexOf(":") + 1)
                .split(",")
                .forEach(s => {
                if (s.length === 0)
                    return;
                cached.pureFuncs[s.trim()] = true;
            });
        });
    }
    if (ast.globals.has("module")) {
        cached.difficult = true;
        ast = parse(`(function(){ var exports = {}; var module = { exports: exports }; var global = this; ${bb.readContent(name)}
__bbe['${name}']=module.exports; }).call(window);`);
        cached.ast = ast;
        cache[name.toLowerCase()] = cached;
        order.push(cached);
        return cached;
    }
    let exportsSymbol = ast.globals.get("exports");
    let unshiftToBody = [];
    let selfExpNames = Object.create(null);
    let varDecls = null;
    let walker = new TreeWalker((node, descend) => {
        if (node instanceof AST_Block) {
            node.body = node.body
                .map((stm) => {
                if (stm instanceof AST_Directive && stm.value === "use strict") {
                    return undefined;
                }
                else if (stm instanceof AST_SimpleStatement) {
                    let stmbody = stm
                        .body;
                    let pea = patternAssignExports(stmbody);
                    if (pea) {
                        let newName = "__export_" + pea.name;
                        if (selfExpNames[pea.name] &&
                            stmbody instanceof AST_Assign) {
                            stmbody.left = new AST_SymbolRef({
                                name: newName,
                                thedef: ast.variables.get(newName)
                            });
                            return stm;
                        }
                        if (isConstantSymbolRef(pea.value)) {
                            selfExpNames[pea.name] = true;
                            let def = pea.value.thedef;
                            def.bbAlwaysClone = true;
                            def.bbExportedFrom = cachedName;
                            cached.selfexports.push({
                                name: pea.name,
                                node: pea.value
                            });
                            return undefined;
                        }
                        let newVar = new AST_Var({
                            start: stmbody.start,
                            end: stmbody.end,
                            definitions: [
                                new AST_VarDef({
                                    name: new AST_SymbolVar({
                                        name: newName,
                                        start: stmbody.start,
                                        end: stmbody.end
                                    }),
                                    value: pea.value
                                })
                            ]
                        });
                        let symb = ast.def_variable(newVar.definitions[0].name);
                        symb.undeclared = false;
                        symb.bbAlwaysClone = true;
                        symb.bbExportedFrom = cachedName;
                        selfExpNames[pea.name] = true;
                        cached.selfexports.push({
                            name: pea.name,
                            node: new AST_SymbolRef({
                                name: newName,
                                thedef: symb
                            })
                        });
                        return newVar;
                    }
                    if (stmbody instanceof AST_Call) {
                        let call = stmbody;
                        if (patternDefinePropertyExportsEsModule(call))
                            return undefined;
                        if (call.args.length === 1 &&
                            call.expression instanceof AST_SymbolRef) {
                            let symb = call.expression;
                            if (isReexport(symb.thedef)) {
                                let req = detectRequireCall(call.args[0]);
                                if (req != null) {
                                    let reqr = bb.resolveRequire(req, name);
                                    if (cached.requires.indexOf(reqr) < 0)
                                        cached.requires.push(reqr);
                                    cached.selfexports.push({
                                        reexport: reqr
                                    });
                                    return undefined;
                                }
                            }
                        }
                    }
                }
                return stm;
            })
                .filter(stm => { return stm != null; });
            descend();
            return true;
        }
        if (node instanceof AST_PropAccess) {
            if (!(walker.parent() instanceof AST_Assign) ||
                !(walker.parent(1) instanceof AST_SimpleStatement)) {
                let propAccess = node;
                if (isExports(propAccess.expression)) {
                    let key = matchPropKey(propAccess);
                    if (key) {
                        if (selfExpNames[key])
                            return false;
                        let newName = "__export_" + key;
                        if (varDecls == null) {
                            let vartop = parse("var a;");
                            let stm = vartop.body[0];
                            unshiftToBody.push(stm);
                            varDecls = stm.definitions;
                            varDecls.pop();
                        }
                        let symbVar = new AST_SymbolVar({
                            name: newName,
                            start: node.start,
                            end: node.end
                        });
                        varDecls.push(new AST_VarDef({
                            name: symbVar,
                            value: undefined
                        }));
                        let symb = ast.def_variable(symbVar);
                        symb.undeclared = false;
                        symb.bbAlwaysClone = true;
                        selfExpNames[key] = true;
                        cached.selfexports.push({
                            name: key,
                            node: new AST_SymbolRef({
                                name: newName,
                                thedef: symb
                            })
                        });
                        return false;
                    }
                }
            }
        }
        let result = detectLazyRequireCall(node);
        if (result != undefined) {
            let reqr = bb.resolveRequire(result, name);
            if (cached.lazyRequires.indexOf(reqr) < 0) {
                cached.lazyRequires.push(reqr);
            }
            return true;
        }
        let req = detectRequireCall(node);
        if (req != null) {
            let reqr = bb.resolveRequire(req, name);
            let parent = walker.parent();
            if (parent instanceof AST_VarDef) {
                let vardef = parent;
                vardef.name.thedef.bbRequirePath = reqr;
            }
            if (cached.requires.indexOf(reqr) < 0)
                cached.requires.push(reqr);
            return true;
        }
        return false;
    });
    ast.walk(walker);
    ast.body.unshift(...unshiftToBody);
    //console.log(ast.print_to_string({ beautify: true }));
    cached.requires.forEach(r => {
        const lowerR = r.toLowerCase();
        if (visited.indexOf(lowerR) >= 0) {
            markRequiredAs(cache[lowerR], cached.partOfBundle, cache);
            return;
        }
        visited.push(lowerR);
        check(r, order, visited, cache, cached.partOfBundle);
    });
    cached.lazyRequires.forEach(r => {
        const lowerR = r.toLowerCase();
        if (visited.indexOf(lowerR) >= 0) {
            markRequiredAs(cache[lowerR], lowerR, cache);
            return;
        }
        visited.push(lowerR);
        check(r, order, visited, cache, lowerR);
    });
    cached.exports = Object.create(null);
    cached.selfexports.forEach(exp => {
        if (exp.name) {
            cached.exports[exp.name] = exp.node;
        }
        else if (exp.reexport) {
            let reexModule = cache[exp.reexport.toLowerCase()];
            if (reexModule.exports) {
                Object.assign(cached.exports, reexModule.exports);
            }
            else {
                reexModule.selfexports.forEach(exp2 => {
                    if (exp2.name) {
                        cached.exports[exp2.name] = exp2.node;
                    }
                });
            }
        }
    });
    order.push(cached);
    return cached;
}
function renameSymbol(node) {
    if (node instanceof AST_Symbol) {
        let symb = node;
        if (symb.thedef == null)
            return node;
        let rename = symb.thedef.bbRename;
        if (rename !== undefined || symb.thedef.bbAlwaysClone) {
            symb = symb.clone();
            if (rename !== undefined) {
                symb.name = rename;
            }
            symb.thedef = undefined;
            symb.scope = undefined;
        }
        return symb;
    }
    return node;
}
function renameSymbolWithReplace(node, split) {
    let imp = split.importsFromOtherBundles.get(node);
    if (imp !== undefined) {
        return imp[3].clone();
    }
    return renameSymbol(node);
}
function emitGlobalDefines(defines) {
    let res = "";
    if (defines == null)
        return res;
    let dns = Object.keys(defines);
    for (let i = 0; i < dns.length; i++) {
        res += "var " + dns[i] + " = " + JSON.stringify(defines[dns[i]]) + ";\n";
    }
    return res;
}
function captureTopLevelVarsFromTslibSource(bundleAst, topLevelNames) {
    bundleAst.figure_out_scope();
    bundleAst
        .body[0].body.expression.variables.each((val, key) => {
        if (key[0] == "_")
            topLevelNames[key] = true;
    });
}
var number2Ident = (function () {
    var leading = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ$_".split("");
    var digits = "0123456789".split("");
    var chars = leading.concat(digits);
    function base54(num) {
        var ret = "", base = 54;
        num++;
        do {
            num--;
            ret += chars[num % base];
            num = Math.floor(num / base);
            base = 64;
        } while (num > 0);
        return ret;
    }
    ;
    return base54;
})();
function bundle(project) {
    let order = [];
    let visited = [];
    let cache = Object.create(null);
    project.mainFiles.forEach(val => {
        const lowerVal = val.toLowerCase();
        if (visited.indexOf(lowerVal) >= 0) {
            markRequiredAs(cache[lowerVal], "", cache);
            return;
        }
        visited.push(lowerVal);
        check(val, order, visited, cache, "");
    });
    let bundleNames = [""];
    let splitMap = Object.create(null);
    splitMap[""] = {
        fullName: "",
        shortName: bb.generateBundleName(""),
        propName: "ERROR",
        exportsUsedFromLazyBundles: new Map(),
        importsFromOtherBundles: new Map()
    };
    let lastGeneratedIdentId = 0;
    function generateIdent() {
        return number2Ident(lastGeneratedIdentId++);
    }
    order.forEach(f => {
        let fullBundleName = f.partOfBundle;
        if (bundleNames.indexOf(fullBundleName) >= 0)
            return;
        let shortenedBundleName = bb.generateBundleName(fullBundleName);
        bundleNames.push(fullBundleName);
        splitMap[fullBundleName] = {
            fullName: fullBundleName,
            shortName: shortenedBundleName,
            propName: generateIdent(),
            exportsUsedFromLazyBundles: new Map(),
            importsFromOtherBundles: new Map()
        };
    });
    if (bundleNames.length > 1)
        detectBundleExportsImports(order, splitMap, cache, generateIdent);
    for (let bundleIndex = 0; bundleIndex < bundleNames.length; bundleIndex++) {
        let bundleAst = parse('(function(undefined){"use strict";\n' + bb.tslibSource(bundleNames.length > 1) + "})()");
        let bodyAst = bundleAst
            .body[0].body.expression.body;
        let pureFuncs = Object.create(null);
        let topLevelNames = Object.create(null);
        captureTopLevelVarsFromTslibSource(bundleAst, topLevelNames);
        let currentBundleName = bundleNames[bundleIndex];
        addAllDifficultFiles(order, currentBundleName, bodyAst);
        renameGlobalVarsAndBuildPureFuncList(order, currentBundleName, topLevelNames, pureFuncs);
        addExternallyImportedFromOtherBundles(bodyAst, splitMap[currentBundleName], topLevelNames);
        order.forEach(f => {
            if (f.partOfBundle !== currentBundleName)
                return;
            if (f.difficult)
                return;
            let transformer = new TreeTransformer((node) => {
                if (node instanceof AST_Label) {
                    return node;
                }
                if (node instanceof AST_Symbol) {
                    let symb = node;
                    if (symb.thedef == null)
                        return undefined;
                    let rename = symb.thedef.bbRename;
                    if (rename !== undefined ||
                        symb.thedef.bbAlwaysClone) {
                        symb = symb.clone();
                        if (rename !== undefined)
                            symb.name = rename;
                        symb.thedef = undefined;
                        symb.scope = undefined;
                        return symb;
                    }
                    let reqPath = symb.thedef.bbRequirePath;
                    if (reqPath !== undefined &&
                        !(transformer.parent() instanceof AST_PropAccess)) {
                        let p = transformer.parent();
                        // don't touch declaration of symbol it will be removed in after function
                        if (p instanceof AST_VarDef && p.name === symb)
                            return undefined;
                        let properties = [];
                        let extf = cache[reqPath.toLowerCase()];
                        if (!extf.difficult) {
                            let keys = Object.keys(extf.exports);
                            keys.forEach(key => {
                                properties.push(new AST_ObjectKeyVal({
                                    quote: "'",
                                    key,
                                    value: renameSymbolWithReplace(extf.exports[key], splitMap[currentBundleName])
                                }));
                            });
                            return new AST_Object({ properties });
                        }
                    }
                }
                if (node instanceof AST_PropAccess) {
                    let propAccess = node;
                    if (isExports(propAccess.expression)) {
                        let key = matchPropKey(propAccess);
                        if (key) {
                            let symb = f.exports[key];
                            if (symb)
                                return renameSymbolWithReplace(symb, splitMap[currentBundleName]);
                        }
                    }
                }
                return undefined;
            }, (node) => {
                var req;
                if (node instanceof AST_Block) {
                    let block = node;
                    block.body = block.body.filter(stm => {
                        if (stm instanceof AST_Var) {
                            let varn = stm;
                            if (varn.definitions.length === 0)
                                return false;
                        }
                        else if (stm instanceof AST_SimpleStatement) {
                            let stmbody = stm
                                .body;
                            if (detectRequireCall(stmbody) != null)
                                return false;
                        }
                        return true;
                    });
                }
                if (node instanceof AST_Toplevel) {
                    let topLevel = node;
                    bodyAst.push(...topLevel.body);
                }
                else if (node instanceof AST_Var) {
                    let varn = node;
                    varn.definitions = varn.definitions.filter(vd => {
                        return vd.name != null;
                    });
                }
                else if (node instanceof AST_VarDef) {
                    let vardef = node;
                    let thedef = vardef.name.thedef;
                    if (thedef && thedef.bbRequirePath) {
                        let extf = cache[thedef.bbRequirePath.toLowerCase()];
                        if (extf.difficult) {
                            vardef.value = parse(`__bbe['${thedef.bbRequirePath}']`).body[0].body;
                        }
                        else {
                            vardef.value = undefined;
                            vardef.name = undefined;
                        }
                    }
                }
                else if (node instanceof AST_PropAccess) {
                    let propAccess = node;
                    if (propAccess.expression instanceof AST_SymbolRef) {
                        let symb = propAccess.expression;
                        let thedef = symb.thedef;
                        if (thedef && thedef.bbRequirePath) {
                            let extf = cache[thedef.bbRequirePath.toLowerCase()];
                            if (!extf.difficult) {
                                let extn = matchPropKey(propAccess);
                                if (extn) {
                                    let asts = extf.exports[extn];
                                    if (asts) {
                                        return renameSymbolWithReplace(asts, splitMap[currentBundleName]);
                                    }
                                    throw new Error("In " +
                                        thedef.bbRequirePath +
                                        " cannot find " +
                                        extn);
                                }
                            }
                        }
                    }
                }
                else if (req = detectLazyRequireCall(node)) {
                    let splitInfo = splitMap[bb.resolveRequire(req, f.name).toLowerCase()];
                    return new AST_Call({ args: [new AST_String({ value: splitInfo.shortName }), new AST_String({ value: splitInfo.propName })], expression: new AST_SymbolRef({ name: "__import", start: {} }) });
                }
                return undefined;
            });
            f.ast.transform(transformer);
        });
        appendExportedFromLazyBundle(bodyAst, splitMap[currentBundleName], cache);
        bundleAst = compressAst(project, bundleAst, pureFuncs);
        mangleNames(project, bundleAst);
        let out = printAst(project, bundleAst);
        out = prependGlobalDefines(project, out);
        if (bundleNames.length > 1 && bundleIndex === 0) {
            out = "var __bbb={};" + out;
        }
        bb.writeBundle(splitMap[currentBundleName].shortName, out);
    }
}
function addSplitImportExport(usesSplit, exportingFile, exportName, splitMap, generateIdent) {
    if (usesSplit.fullName === exportingFile.partOfBundle)
        return;
    let exportingSplit = splitMap[exportingFile.partOfBundle];
    let astNode = exportingFile.exports[exportName];
    usesSplit.importsFromOtherBundles.set(astNode, [exportingSplit, exportingFile, exportName, undefined]);
    exportingSplit.exportsUsedFromLazyBundles.set(astNode, generateIdent());
}
function detectBundleExportsImports(order, splitMap, cache, generateIdent) {
    order.forEach(f => {
        if (f.difficult)
            return;
        const fSplit = splitMap[f.partOfBundle];
        let walker = new TreeWalker((node) => {
            if (node instanceof AST_Symbol) {
                let symb = node;
                if (symb.thedef == null)
                    return false;
                let reqPath = symb.thedef.bbRequirePath;
                if (reqPath === undefined)
                    return false;
                let extf = cache[reqPath.toLowerCase()];
                if (extf.difficult)
                    return false;
                let p = walker.parent();
                if (p instanceof AST_PropAccess && typeof p.property === "string") {
                    addSplitImportExport(fSplit, extf, p.property, splitMap, generateIdent);
                }
                else if (p instanceof AST_VarDef && p.name === symb) {
                    return false;
                }
                else {
                    let keys = Object.keys(extf.exports);
                    keys.forEach(key => {
                        addSplitImportExport(fSplit, extf, key, splitMap, generateIdent);
                    });
                }
                return false;
            }
            return false;
        });
        f.ast.walk(walker);
    });
}
function fileNameToIdent(fn) {
    if (fn.lastIndexOf("/") >= 0)
        fn = fn.substr(fn.lastIndexOf("/") + 1);
    if (fn.indexOf(".") >= 0)
        fn = fn.substr(0, fn.indexOf("."));
    fn = fn.replace(/-/g, "_");
    return fn;
}
function newSymbolRef(name) {
    return new AST_SymbolRef({ name, thedef: undefined, scope: undefined, start: {} });
}
function addExternallyImportedFromOtherBundles(bodyAst, split, topLevelNames) {
    const importsMap = split.importsFromOtherBundles;
    let imports = Array.from(importsMap.keys());
    for (let i = 0; i < imports.length; i++) {
        let imp = importsMap.get(imports[i]);
        let name = "__" + imp[2] + "_" + fileNameToIdent(imp[1].name);
        name = makeUniqueIdent(topLevelNames, name);
        imp[3] = newSymbolRef(name);
        let shortenedPropertyName = imp[0].exportsUsedFromLazyBundles.get(imports[i]);
        bodyAst.push(new AST_Var({
            definitions: [new AST_VarDef({
                    name: new AST_SymbolVar({ name, thedef: undefined, scope: undefined, init: undefined, start: {} }),
                    value: new AST_Dot({
                        expression: newSymbolRef("__bbb"),
                        property: shortenedPropertyName
                    })
                })]
        }));
    }
}
function makeUniqueIdent(topLevelNames, name) {
    let suffix = "";
    let iteration = 0;
    while (topLevelNames[name + suffix] !== undefined) {
        suffix = "" + (++iteration);
    }
    name += suffix;
    topLevelNames[name] = true;
    return name;
}
function renameGlobalVarsAndBuildPureFuncList(order, currentBundleName, topLevelNames, pureFuncs) {
    order.forEach(f => {
        if (f.partOfBundle !== currentBundleName)
            return;
        if (f.difficult)
            return;
        let suffix = fileNameToIdent(f.name);
        let walker = new TreeWalker((node, descend) => {
            if (node instanceof AST_Scope) {
                node.variables.each((symb, name) => {
                    if (symb.bbRequirePath)
                        return;
                    let newname = symb.bbRename || name;
                    if (topLevelNames[name] !== undefined &&
                        (node === f.ast || node.enclosed.some(enclSymb => topLevelNames[enclSymb.name] !== undefined))) {
                        let index = 0;
                        do {
                            index++;
                            newname = name + "_" + suffix;
                            if (index > 1)
                                newname += "" + index;
                        } while (topLevelNames[newname] !== undefined);
                        symb.bbRename = newname;
                    }
                    else {
                        symb.bbRename = undefined;
                    }
                    if (node === f.ast) {
                        if (name in f.pureFuncs) {
                            pureFuncs[newname] = true;
                        }
                        topLevelNames[newname] = true;
                    }
                });
            }
            return false;
        });
        f.ast.walk(walker);
    });
}
function addAllDifficultFiles(order, currentBundleName, bodyAst) {
    let wasSomeDifficult = false;
    order.forEach(f => {
        if (f.partOfBundle !== currentBundleName)
            return;
        if (!f.difficult)
            return;
        if (!wasSomeDifficult) {
            let ast = parse("var __bbe={};");
            bodyAst.push(...ast.body);
            wasSomeDifficult = true;
        }
        bodyAst.push(...f.ast.body);
    });
}
function appendExportedFromLazyBundle(bodyAst, split, cache) {
    if (split.fullName != "") {
        let file = cache[split.fullName];
        let properties = [];
        let keys = Object.keys(file.exports);
        keys.forEach(key => {
            properties.push(new AST_ObjectKeyVal({
                quote: "'",
                key,
                value: renameSymbol(file.exports[key])
            }));
        });
        bodyAst.push(new AST_SimpleStatement({
            body: new AST_Assign({
                operator: "=",
                left: new AST_Dot({
                    expression: new AST_SymbolRef({
                        name: "__bbb"
                    }),
                    property: split.propName
                }),
                right: new AST_Object({ properties })
            })
        }));
    }
    split.exportsUsedFromLazyBundles.forEach((propName, valueNode) => {
        bodyAst.push(new AST_SimpleStatement({
            body: new AST_Assign({
                operator: "=",
                left: new AST_Dot({
                    expression: new AST_SymbolRef({
                        name: "__bbb"
                    }),
                    property: propName
                }),
                right: renameSymbol(valueNode)
            })
        }));
    });
}
function prependGlobalDefines(project, out) {
    if (project.compress === false) {
        out = emitGlobalDefines(project.defines) + out;
    }
    return out;
}
function printAst(project, bundleAst) {
    let os = OutputStream({
        beautify: project.beautify === true
    });
    bundleAst.print(os);
    let out = os.toString();
    return out;
}
function compressAst(project, bundleAst, pureFuncs) {
    if (project.compress !== false) {
        bundleAst.figure_out_scope();
        let compressor = Compressor({
            hoist_funs: false,
            warnings: false,
            unsafe: true,
            global_defs: project.defines,
            pure_funcs: call => {
                if (call.start !== undefined && call.start.comments_before != null && call.start.comments_before.length === 1) {
                    let c = call.start.comments_before[0];
                    if (c.type === "comment2" && c.value.indexOf("@class") >= 0) {
                        return false;
                    }
                }
                if (call.expression instanceof AST_SymbolRef) {
                    let symb = call.expression;
                    if (symb.thedef.scope.parent_scope != undefined &&
                        symb.thedef.scope.parent_scope.parent_scope == null) {
                        if (symb.name in pureFuncs)
                            return false;
                    }
                    return true;
                }
                return true;
            }
        });
        bundleAst = bundleAst.transform(compressor);
        // in future to make another pass with removing function calls with empty body
    }
    return bundleAst;
}
function mangleNames(project, bundleAst) {
    if (project.mangle !== false) {
        bundleAst.figure_out_scope();
        let rootScope = undefined;
        let walker = new TreeWalker(n => {
            if (n !== bundleAst && n instanceof AST_Scope) {
                rootScope = n;
                return true;
            }
            return false;
        });
        bundleAst.walk(walker);
        rootScope.uses_eval = false;
        rootScope.uses_with = false;
        base54.reset();
        bundleAst.compute_char_frequency();
        bundleAst.mangle_names();
    }
}
function bbBundle(params) {
    bundle(JSON.parse(params));
}
