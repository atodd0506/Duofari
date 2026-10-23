#!/usr/bin/env python3
"""Generates apple/Duofari.xcodeproj from the files in the repository.

The project follows the structure of Apple's WWDC26 Safari web extension
sample: an iPhone app target that embeds a Safari web extension target. The web
extension's resources are referenced straight from ../extension, so the
extension directory stays the single source of truth. Top-level files are added
individually to Copy Bundle Resources, and subdirectories (images, _locales) as
folder references so they keep their paths inside the .appex.

The native folders apple/Duofari and apple/Duofari Extension are scanned too:
Swift files go to each target's Sources, asset catalogs, privacy manifests and
string catalogs to its Resources, and Info.plist is used as the target's
Info.plist.

Run it again after adding or removing files in extension/ or apple/:

    python3 scripts/gen-xcodeproj.py [--bundle-id com.example.Duofari] [--team ABCDE12345] [--build 42]

The build number defaults to the number of commits on HEAD. Object identifiers
are derived from stable names, so regenerating an unchanged tree at the same
commit produces an identical file.
"""

import argparse
import hashlib
import os
import subprocess
import sys

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
APPLE = os.path.join(ROOT, "apple")
EXTENSION = os.path.join(ROOT, "extension")
PROJECT = os.path.join(APPLE, "Duofari.xcodeproj")

APP_NAME = "Duofari"
EXT_NAME = "Duofari Extension"
APP_DIR = os.path.join(APPLE, APP_NAME)
EXT_DIR = os.path.join(APPLE, EXT_NAME)
DEPLOYMENT_TARGET = "27.0"

# Files in a native target folder that are copied into the bundle.
NATIVE_RESOURCE_TYPES = (".xcassets", ".xcprivacy", ".xcstrings")

FILE_TYPES = {
    ".swift": "sourcecode.swift",
    ".plist": "text.plist.xml",
    ".json": "text.json",
    ".js": "sourcecode.javascript",
    ".html": "text.html",
    ".css": "text.css",
    ".png": "image.png",
    ".svg": "text.svg",
    ".xcassets": "folder.assetcatalog",
    ".xcprivacy": "text.xml",
    ".xcstrings": "text.json.xcstrings",
}


def oid(name):
    """A stable 24-hex-digit object identifier."""
    return hashlib.md5(("duofari:" + name).encode()).hexdigest()[:24].upper()


def q(value):
    """Quotes a pbxproj string when needed."""
    if value and all(c.isalnum() or c in "._/$" for c in value) and not value.startswith("$("):
        return value
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--bundle-id", default="com.example.Duofari", help="app bundle identifier; the extension gets '.Extension' appended")
    parser.add_argument("--team", default="", help="Apple developer team ID for automatic signing")
    parser.add_argument("--version", default=None, help="marketing version (default: manifest.json version)")
    parser.add_argument("--build", default=None, help="build number (CURRENT_PROJECT_VERSION; default: git commit count)")
    return parser.parse_args()


def manifest_version():
    import json
    with open(os.path.join(EXTENSION, "manifest.json")) as f:
        return json.load(f)["version"]


def git_commit_count():
    """The number of commits on HEAD, or "1" outside a git checkout."""
    try:
        result = subprocess.run(["git", "rev-list", "--count", "HEAD"], cwd=ROOT,
                                capture_output=True, text=True, check=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return "1"
    count = result.stdout.strip()
    return count if count.isdigit() else "1"


def native_entries(directory):
    """Lists the Swift sources and bundle resources in a native target folder, which must hold an Info.plist."""
    if not os.path.isfile(os.path.join(directory, "Info.plist")):
        sys.exit(f"{os.path.relpath(directory, ROOT)}/Info.plist is missing")
    sources, resources = [], []
    for name in sorted(os.listdir(directory)):
        ext = os.path.splitext(name)[1]
        if name.startswith(".") or name == "Info.plist":
            continue
        if ext == ".swift":
            sources.append(name)
        elif ext in NATIVE_RESOURCE_TYPES:
            resources.append(name)
        else:
            print(f"warning: ignoring {os.path.relpath(os.path.join(directory, name), ROOT)}", file=sys.stderr)
    if not sources:
        sys.exit(f"{os.path.relpath(directory, ROOT)} has no Swift files")
    return sources, resources


def extension_entries():
    files, folders = [], []
    for name in sorted(os.listdir(EXTENSION)):
        if name.startswith("."):
            continue
        path = os.path.join(EXTENSION, name)
        (folders if os.path.isdir(path) else files).append(name)
    return files, folders


def main():
    args = parse_args()
    version = args.version or manifest_version()
    build = args.build or git_commit_count()
    ext_files, ext_folders = extension_entries()
    if "manifest.json" not in ext_files:
        sys.exit("extension/manifest.json is missing")
    app_swift, app_resource_names = native_entries(APP_DIR)
    ext_swift, ext_resource_names = native_entries(EXT_DIR)
    clashes = sorted(set(ext_resource_names) & set(ext_files + ext_folders))
    if clashes:
        sys.exit(f"{EXT_NAME} resources clash with extension/: {', '.join(clashes)}")

    objects = {}  # id -> (comment, body lines)

    def add(object_id, comment, fields):
        objects[object_id] = (comment, fields)
        return object_id

    def file_ref(key, path, name=None, file_type=None, folder=False):
        ext = os.path.splitext(path)[1]
        fields = [("isa", "PBXFileReference")]
        if folder:
            fields.append(("lastKnownFileType", "folder"))
        else:
            fields.append(("lastKnownFileType", file_type or FILE_TYPES.get(ext, "file")))
        if name:
            fields.append(("name", q(name)))
        fields += [("path", q(path)), ("sourceTree", '"<group>"')]
        return add(oid("ref:" + key), name or os.path.basename(path), fields)

    def product_ref(key, path, file_type):
        return add(oid("product:" + key), path, [
            ("isa", "PBXFileReference"), ("explicitFileType", q(file_type)), ("includeInIndex", "0"),
            ("path", q(path)), ("sourceTree", "BUILT_PRODUCTS_DIR"),
        ])

    def build_file(key, ref, ref_name, phase, settings=None):
        fields = [("isa", "PBXBuildFile"), ("fileRef", f"{ref} /* {ref_name} */")]
        if settings:
            fields.append(("settings", settings))
        return add(oid("build:" + key), f"{ref_name} in {phase}", fields)

    def group(key, name, children, path=None, source_tree='"<group>"'):
        fields = [("isa", "PBXGroup"), ("children", children)]
        if name and (path is None or name != path):
            fields.append(("name", q(name)))
        if path is not None:
            fields.append(("path", q(path)))
        fields.append(("sourceTree", source_tree))
        return add(oid("group:" + key), name, fields)

    def phase(key, isa, name, files, extra=None):
        fields = [("isa", isa)]
        if extra:
            fields += extra
        fields += [("buildActionMask", "2147483647"), ("files", files), ("runOnlyForDeploymentPostprocessing", "0")]
        return add(oid("phase:" + key), name, fields)

    def ref_list(items):
        return [f"{i} /* {objects[i][0]} */" for i in items]

    # --- App target files ---------------------------------------------------
    app_refs = {name: file_ref("app/" + name, name) for name in app_swift + app_resource_names}
    app_plist = file_ref("app/Info.plist", "Info.plist")

    # --- Extension target files ---------------------------------------------
    ext_refs = {name: file_ref("ext/" + name, name) for name in ext_swift + ext_resource_names}
    ext_plist = file_ref("ext/Info.plist", "Info.plist")
    res_refs = {}
    for name in ext_files:
        res_refs[name] = file_ref("res/" + name, name)
    for name in ext_folders:
        res_refs[name] = file_ref("res/" + name, name, folder=True)

    # --- Products -------------------------------------------------------------
    app_product = product_ref("app", f"{APP_NAME}.app", "wrapper.application")
    ext_product = product_ref("ext", f"{EXT_NAME}.appex", "wrapper.app-extension")

    # --- Build files ----------------------------------------------------------
    app_source_builds = [build_file("app-src/" + n, app_refs[n], n, "Sources") for n in app_swift]
    app_resource_builds = [build_file("app-res/" + n, app_refs[n], n, "Resources") for n in app_resource_names]
    embed_build = build_file("embed", ext_product, f"{EXT_NAME}.appex", "Embed Foundation Extensions",
                             settings="{ATTRIBUTES = (RemoveHeadersOnCopy, ); }")
    ext_source_builds = [build_file("ext-src/" + n, ext_refs[n], n, "Sources") for n in ext_swift]
    ext_resource_builds = [build_file("ext-native-res/" + n, ext_refs[n], n, "Resources") for n in ext_resource_names]
    ext_resource_builds += [build_file("ext-res/" + n, res_refs[n], n, "Resources") for n in ext_files + ext_folders]

    # --- Groups -----------------------------------------------------------------
    app_group = group("app", APP_NAME, ref_list([*app_refs.values(), app_plist]), path=APP_NAME)
    ext_group = group("ext", EXT_NAME, ref_list([*ext_refs.values(), ext_plist]), path=EXT_NAME)
    res_group = group("res", "Resources (extension)", ref_list(list(res_refs.values())), path="../extension")
    products_group = group("products", "Products", ref_list([app_product, ext_product]))
    main_group = add(oid("group:main"), "", [
        ("isa", "PBXGroup"),
        ("children", ref_list([app_group, ext_group, res_group, products_group])),
        ("sourceTree", '"<group>"'),
    ])

    # --- Build phases -------------------------------------------------------------
    app_sources = phase("app-sources", "PBXSourcesBuildPhase", "Sources", ref_list(app_source_builds))
    app_frameworks = phase("app-frameworks", "PBXFrameworksBuildPhase", "Frameworks", [])
    app_resources = phase("app-resources", "PBXResourcesBuildPhase", "Resources", ref_list(app_resource_builds))
    app_embed = phase("app-embed", "PBXCopyFilesBuildPhase", "Embed Foundation Extensions", ref_list([embed_build]),
                      extra=[("dstPath", '""'), ("dstSubfolderSpec", "13"), ("name", q("Embed Foundation Extensions"))])
    ext_sources = phase("ext-sources", "PBXSourcesBuildPhase", "Sources", ref_list(ext_source_builds))
    ext_frameworks = phase("ext-frameworks", "PBXFrameworksBuildPhase", "Frameworks", [])
    ext_resources = phase("ext-resources", "PBXResourcesBuildPhase", "Resources", ref_list(ext_resource_builds))

    # --- Build configurations --------------------------------------------------------
    common_project = {
        "ALWAYS_SEARCH_USER_PATHS": "NO",
        "ASSETCATALOG_COMPILER_GENERATE_SWIFT_ASSET_SYMBOL_EXTENSIONS": "YES",
        "CLANG_ENABLE_MODULES": "YES",
        "CLANG_ENABLE_OBJC_ARC": "YES",
        "COPY_PHASE_STRIP": "NO",
        "ENABLE_STRICT_OBJC_MSGSEND": "YES",
        "ENABLE_USER_SCRIPT_SANDBOXING": "YES",
        "GCC_C_LANGUAGE_STANDARD": "gnu17",
        "IPHONEOS_DEPLOYMENT_TARGET": DEPLOYMENT_TARGET,
        "LOCALIZATION_PREFERS_STRING_CATALOGS": "YES",
        "SDKROOT": "iphoneos",
    }
    project_debug = dict(common_project, **{
        "DEBUG_INFORMATION_FORMAT": "dwarf",
        "ENABLE_TESTABILITY": "YES",
        "GCC_OPTIMIZATION_LEVEL": "0",
        "ONLY_ACTIVE_ARCH": "YES",
        "SWIFT_ACTIVE_COMPILATION_CONDITIONS": "DEBUG $(inherited)",
        "SWIFT_OPTIMIZATION_LEVEL": "-Onone",
    })
    project_release = dict(common_project, **{
        "DEBUG_INFORMATION_FORMAT": "dwarf-with-dsym",
        "ENABLE_NS_ASSERTIONS": "NO",
        "SWIFT_COMPILATION_MODE": "wholemodule",
        "VALIDATE_PRODUCT": "YES",
    })
    common_target = {
        "CODE_SIGN_STYLE": "Automatic",
        "CURRENT_PROJECT_VERSION": build,
        "DEVELOPMENT_TEAM": args.team,
        "GENERATE_INFOPLIST_FILE": "YES",
        "MARKETING_VERSION": version,
        "SWIFT_EMIT_LOC_STRINGS": "YES",
        "SWIFT_VERSION": "5.0",
        "TARGETED_DEVICE_FAMILY": "1",  # iPhone only
    }
    app_settings = dict(common_target, **{
        "ASSETCATALOG_COMPILER_APPICON_NAME": "AppIcon",
        "ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME": "AccentColor",
        "INFOPLIST_FILE": f"{APP_NAME}/Info.plist",
        "INFOPLIST_KEY_CFBundleDisplayName": APP_NAME,
        "INFOPLIST_KEY_LSApplicationCategoryType": "public.app-category.utilities",
        "INFOPLIST_KEY_UIApplicationSceneManifest_Generation": "YES",
        "INFOPLIST_KEY_UIApplicationSupportsIndirectInputEvents": "YES",
        "INFOPLIST_KEY_UILaunchScreen_Generation": "YES",
        "INFOPLIST_KEY_UISupportedInterfaceOrientations": "UIInterfaceOrientationPortrait UIInterfaceOrientationLandscapeLeft UIInterfaceOrientationLandscapeRight",
        "LD_RUNPATH_SEARCH_PATHS": ["$(inherited)", "@executable_path/Frameworks"],
        "OTHER_LDFLAGS": ["-framework", "SafariServices"],
        "PRODUCT_BUNDLE_IDENTIFIER": args.bundle_id,
        "PRODUCT_NAME": "$(TARGET_NAME)",
    })
    ext_settings = dict(common_target, **{
        "INFOPLIST_FILE": f"{EXT_NAME}/Info.plist",
        "INFOPLIST_KEY_CFBundleDisplayName": APP_NAME,
        "INFOPLIST_KEY_NSHumanReadableCopyright": "",
        "LD_RUNPATH_SEARCH_PATHS": ["$(inherited)", "@executable_path/Frameworks", "@executable_path/../../Frameworks"],
        "OTHER_LDFLAGS": ["-framework", "SafariServices"],
        "PRODUCT_BUNDLE_IDENTIFIER": args.bundle_id + ".Extension",
        "PRODUCT_NAME": "$(TARGET_NAME)",
        "SKIP_INSTALL": "YES",
    })

    def config(key, name, settings):
        return add(oid("config:" + key), name, [("isa", "XCBuildConfiguration"), ("buildSettings", settings), ("name", name)])

    def config_list(key, label, debug, release):
        return add(oid("configlist:" + key), f"Build configuration list for {label}", [
            ("isa", "XCConfigurationList"),
            ("buildConfigurations", ref_list([debug, release])),
            ("defaultConfigurationIsVisible", "0"),
            ("defaultConfigurationName", "Release"),
        ])

    project_configs = config_list("project", f'PBXProject "{APP_NAME}"',
                                  config("project-debug", "Debug", project_debug),
                                  config("project-release", "Release", project_release))
    app_configs = config_list("app", f'PBXNativeTarget "{APP_NAME}"',
                              config("app-debug", "Debug", app_settings),
                              config("app-release", "Release", app_settings))
    ext_configs = config_list("ext", f'PBXNativeTarget "{EXT_NAME}"',
                              config("ext-debug", "Debug", ext_settings),
                              config("ext-release", "Release", ext_settings))

    # --- Targets -------------------------------------------------------------------
    ext_target_id = oid("target:ext")
    app_target_id = oid("target:app")
    project_id = oid("project")
    proxy = add(oid("proxy:ext"), "PBXContainerItemProxy", [
        ("isa", "PBXContainerItemProxy"),
        ("containerPortal", f"{project_id} /* Project object */"),
        ("proxyType", "1"),
        ("remoteGlobalIDString", ext_target_id),
        ("remoteInfo", q(EXT_NAME)),
    ])
    dependency = add(oid("dependency:ext"), "PBXTargetDependency", [
        ("isa", "PBXTargetDependency"),
        ("target", f"{ext_target_id} /* {EXT_NAME} */"),
        ("targetProxy", f"{proxy} /* PBXContainerItemProxy */"),
    ])
    add(ext_target_id, EXT_NAME, [
        ("isa", "PBXNativeTarget"),
        ("buildConfigurationList", f"{ext_configs} /* {objects[ext_configs][0]} */"),
        ("buildPhases", ref_list([ext_sources, ext_frameworks, ext_resources])),
        ("buildRules", []),
        ("dependencies", []),
        ("name", q(EXT_NAME)),
        ("productName", q(EXT_NAME)),
        ("productReference", f"{ext_product} /* {EXT_NAME}.appex */"),
        ("productType", q("com.apple.product-type.app-extension")),
    ])
    add(app_target_id, APP_NAME, [
        ("isa", "PBXNativeTarget"),
        ("buildConfigurationList", f"{app_configs} /* {objects[app_configs][0]} */"),
        ("buildPhases", ref_list([app_sources, app_frameworks, app_resources, app_embed])),
        ("buildRules", []),
        ("dependencies", [f"{dependency} /* PBXTargetDependency */"]),
        ("name", q(APP_NAME)),
        ("productName", q(APP_NAME)),
        ("productReference", f"{app_product} /* {APP_NAME}.app */"),
        ("productType", q("com.apple.product-type.application")),
    ])
    add(project_id, "Project object", [
        ("isa", "PBXProject"),
        ("attributes", "{\n\t\t\t\tBuildIndependentTargetsInParallel = 1;\n\t\t\t\tLastSwiftUpdateCheck = 2700;\n\t\t\t\tLastUpgradeCheck = 2700;\n"
                       f"\t\t\t\tTargetAttributes = {{\n\t\t\t\t\t{app_target_id} = {{\n\t\t\t\t\t\tCreatedOnToolsVersion = 27.0;\n\t\t\t\t\t}};\n"
                       f"\t\t\t\t\t{ext_target_id} = {{\n\t\t\t\t\t\tCreatedOnToolsVersion = 27.0;\n\t\t\t\t\t}};\n\t\t\t\t}};\n\t\t\t}}"),
        ("buildConfigurationList", f"{project_configs} /* {objects[project_configs][0]} */"),
        ("developmentRegion", "en"),
        ("hasScannedForEncodings", "0"),
        ("knownRegions", ["en", "Base"]),
        ("mainGroup", main_group),
        ("minimizedProjectReferenceProxies", "1"),
        ("preferredProjectObjectVersion", "77"),
        ("productRefGroup", f"{products_group} /* Products */"),
        ("projectDirPath", '""'),
        ("projectRoot", '""'),
        ("targets", [f"{app_target_id} /* {APP_NAME} */", f"{ext_target_id} /* {EXT_NAME} */"]),
    ])

    # --- Serialise ---------------------------------------------------------------------
    def render_value(value, indent, quote=False):
        tabs = "\t" * indent
        if isinstance(value, list):
            if not value:
                return "(\n" + tabs + ")"
            items = (item if " /* " in item else q(item) for item in value)
            return "(\n" + "".join(f"{tabs}\t{item},\n" for item in items) + tabs + ")"
        if isinstance(value, dict):
            body = "".join(f"{tabs}\t{k} = {render_value(v, indent + 1, quote=True)};\n" for k, v in sorted(value.items()))
            return "{\n" + body + tabs + "}"
        return q(value) if quote else value

    sections = {}
    for object_id, (comment, fields) in objects.items():
        isa = dict(fields)["isa"]
        sections.setdefault(isa, []).append((object_id, comment, fields))

    out = ["// !$*UTF8*$!", "{", "\tarchiveVersion = 1;", "\tclasses = {", "\t};", "\tobjectVersion = 77;", "\tobjects = {", ""]
    for isa in sorted(sections):
        out.append(f"/* Begin {isa} section */")
        for object_id, comment, fields in sorted(sections[isa]):
            label = f" /* {comment} */" if comment else ""
            if isa in ("PBXBuildFile", "PBXFileReference"):
                inline = " ".join(f"{k} = {v};" for k, v in fields)
                out.append(f"\t\t{object_id}{label} = {{{inline} }};")
            else:
                out.append(f"\t\t{object_id}{label} = {{")
                for key, value in fields:
                    out.append(f"\t\t\t{key} = {render_value(value, 3)};")
                out.append("\t\t};")
        out.append(f"/* End {isa} section */")
        out.append("")
    out += ["\t};", f"\trootObject = {project_id} /* Project object */;", "}", ""]

    os.makedirs(PROJECT, exist_ok=True)
    with open(os.path.join(PROJECT, "project.pbxproj"), "w") as f:
        f.write("\n".join(out))

    workspace = os.path.join(PROJECT, "project.xcworkspace")
    os.makedirs(workspace, exist_ok=True)
    with open(os.path.join(workspace, "contents.xcworkspacedata"), "w") as f:
        f.write('<?xml version="1.0" encoding="UTF-8"?>\n<Workspace\n   version = "1.0">\n   <FileRef\n      location = "self:">\n   </FileRef>\n</Workspace>\n')

    schemes = os.path.join(PROJECT, "xcshareddata", "xcschemes")
    os.makedirs(schemes, exist_ok=True)
    with open(os.path.join(schemes, f"{APP_NAME}.xcscheme"), "w") as f:
        f.write(SCHEME.format(app_id=app_target_id, ext_id=ext_target_id, app=APP_NAME, ext=EXT_NAME))

    print(f"Wrote {os.path.relpath(PROJECT, ROOT)} (version {version} build {build}, "
          f"{len(app_swift)} + {len(ext_swift)} Swift files, {len(ext_files)} files + {len(ext_folders)} folders of extension resources)")


SCHEME = """<?xml version="1.0" encoding="UTF-8"?>
<Scheme
   LastUpgradeVersion = "2700"
   version = "1.7">
   <BuildAction
      parallelizeBuildables = "YES"
      buildImplicitDependencies = "YES">
      <BuildActionEntries>
         <BuildActionEntry
            buildForTesting = "YES"
            buildForRunning = "YES"
            buildForProfiling = "YES"
            buildForArchiving = "YES"
            buildForAnalyzing = "YES">
            <BuildableReference
               BuildableIdentifier = "primary"
               BlueprintIdentifier = "{app_id}"
               BuildableName = "{app}.app"
               BlueprintName = "{app}"
               ReferencedContainer = "container:Duofari.xcodeproj">
            </BuildableReference>
         </BuildActionEntry>
      </BuildActionEntries>
   </BuildAction>
   <TestAction
      buildConfiguration = "Debug"
      selectedDebuggerIdentifier = "Xcode.DebuggerFoundation.Debugger.LLDB"
      selectedLauncherIdentifier = "Xcode.DebuggerFoundation.Launcher.LLDB"
      shouldUseLaunchSchemeArgsEnv = "YES">
   </TestAction>
   <LaunchAction
      buildConfiguration = "Debug"
      selectedDebuggerIdentifier = "Xcode.DebuggerFoundation.Debugger.LLDB"
      selectedLauncherIdentifier = "Xcode.DebuggerFoundation.Launcher.LLDB"
      launchStyle = "0"
      useCustomWorkingDirectory = "NO"
      ignoresPersistentStateOnLaunch = "NO"
      debugDocumentVersioning = "YES"
      debugServiceExtension = "internal"
      allowLocationSimulation = "YES">
      <BuildableProductRunnable
         runnableDebuggingMode = "0">
         <BuildableReference
            BuildableIdentifier = "primary"
            BlueprintIdentifier = "{app_id}"
            BuildableName = "{app}.app"
            BlueprintName = "{app}"
            ReferencedContainer = "container:Duofari.xcodeproj">
         </BuildableReference>
      </BuildableProductRunnable>
   </LaunchAction>
   <ProfileAction
      buildConfiguration = "Release"
      shouldUseLaunchSchemeArgsEnv = "YES"
      savedToolIdentifier = ""
      useCustomWorkingDirectory = "NO"
      debugDocumentVersioning = "YES">
      <BuildableProductRunnable
         runnableDebuggingMode = "0">
         <BuildableReference
            BuildableIdentifier = "primary"
            BlueprintIdentifier = "{app_id}"
            BuildableName = "{app}.app"
            BlueprintName = "{app}"
            ReferencedContainer = "container:Duofari.xcodeproj">
         </BuildableReference>
      </BuildableProductRunnable>
   </ProfileAction>
   <AnalyzeAction
      buildConfiguration = "Debug">
   </AnalyzeAction>
   <ArchiveAction
      buildConfiguration = "Release"
      revealArchiveInOrganizer = "YES">
   </ArchiveAction>
</Scheme>
"""

if __name__ == "__main__":
    main()
