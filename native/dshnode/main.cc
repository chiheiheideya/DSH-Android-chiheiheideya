// libdshnode.so — a `node` executable for child processes of the engine.
//
// The engine itself runs Node inside the app process (libdshengine.so → node::Start), so the
// device has no node binary to spawn. Package operations (bundled pnpm), JavaScript MCP
// servers and plugins that `spawn('node', …)` need one. This is Node's own POSIX main()
// (src/node_main.cc) linked against libnode.so: a PIE executable, shipped as lib*.so so the
// package manager extracts it into nativeLibraryDir, the one app location Android allows to
// exec. RUNPATH $ORIGIN finds libnode.so / libc++_shared.so next to it; the app links
// files/bin/node → <nativeLibraryDir>/libdshnode.so and exports DSH_NODE_BIN.
//
// process.execPath is this file, so `spawn(process.execPath, …)` from a child works too.

#include <node.h>

int main(int argc, char* argv[]) {
  return node::Start(argc, argv);
}
