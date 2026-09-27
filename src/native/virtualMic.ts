/* eslint-disable @typescript-eslint/no-explicit-any */
// Disable any checks because node-pipewire doesn't have types for our submodule
import { app, ipcMain } from "electron";

import { sinkName, sourceName } from "../constants";

const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));

function getPids() {
  return app.getAppMetrics().map((proc) => proc.pid ?? -1);
}

export const isWayland =
  process.platform === "linux" &&
  (process.env.XDG_SESSION_TYPE === "wayland" || !!process.env.WAYLAND_DISPLAY);

ipcMain.handle("getIsWayland", () => isWayland);

export async function initVirtualMic() {
  // Only available on Wayland
  if (!isWayland) return;

  try {
    const {
      createPwThread,
      createSink,
      createSource,
      getClients,
      getNodes,
      getPorts,
      linkNodesNameToId,
      linkPorts,
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      //@ts-ignore This module may not be found on non-linux builds.
    } = await import("node-pipewire"); //eslint-disable-line

    createPwThread();

    // Wait for pipewire thread to start and gather neccessary data
    await delay(100);

    let nodes: any[] = getNodes();

    let sinkFound = false;
    let sourceFound = false;
    for (const node of nodes) {
      if (node.name === sinkName) {
        sinkFound = true;
      }
      if (node.name === sourceName) {
        sourceFound = true;
      }
    }

    if (!sinkFound) {
      createSink(sinkName, ["FL", "FR"], false);
    }

    if (!sourceFound) {
      createSource(sourceName, ["FL", "FR"], false);
    }

    // Wait for source and sink to save
    await delay(100);

    const appName = app.getName();

    nodes = getNodes();
    const linkedPorts = new Set<number>();
    const sourceNode = nodes.filter((node: any) => node.name === sourceName)[0];
    const sinkNode = nodes.filter((node: any) => node.name === sinkName)[0];

    linkNodesNameToId(sinkNode.name, sourceNode.id, false);

    setInterval(() => {
      const ourClients: Record<number, any> = {};
      const paClients: any[] = [];

      const pids = getPids();
      const clients = getClients();
      for (const client of clients) {
        // If the client belongs to one of the electron processes
        if (pids.includes(client.pid)) {
          ourClients[client.pid] = client;
        }
        // If the client is a pulse audio client made on behalf of this app
        if (client.application_name === appName) {
          paClients.push(client);
        }
      }

      nodes = getNodes()
        // Only choose output streams
        .filter(
          (node: any) => node.props["media.class"] === "Stream/Output/Audio",
        )
        // Ignore any nodes from electron's processes
        .filter(
          (node: any) =>
            !Object.values(ourClients)
              .map((client) => client.id)
              .includes(Number(node.props["client.id"])),
        )
        // Ignore any nodes from pulse audio processes for the app
        .filter(
          (node: any) =>
            !paClients
              .map((client) => client.id)
              .includes(Number(node.props["client.id"])),
        );
      const streamIds = new Set(nodes.map((node) => node.id));

      // node.ports keeps ports after they are removed, and linkPorts panics
      // the pipewire thread on an id it can't find, so only trust getPorts().
      const ports: any[] = getPorts();

      const sinkInputs: Record<string, number> = {};
      for (const port of ports) {
        if (port.node_id === sinkNode.id && port.direction === "Input") {
          sinkInputs[port.props["audio.channel"]] = port.id;
        }
      }

      // Link by port id, never by node name (linkNodesNameToId): apps reuse
      // one node.name for playback and capture, and that links every output
      // port of every node with the name -- including the monitor ports of the
      // app's microphone stream. Discord's "WEBRTC VoiceEngine" did exactly
      // this and put the user's mic in the screen share.
      const livePorts = new Set<number>();
      for (const port of ports) {
        if (!streamIds.has(port.node_id) || port.direction !== "Output") {
          continue;
        }
        livePorts.add(port.id);

        const sinkInput = sinkInputs[port.props["audio.channel"]];
        if (sinkInput === undefined || linkedPorts.has(port.id)) continue;

        linkPorts(sinkInput, port.id, false);
        linkedPorts.add(port.id);
      }

      // Cleanup linkedPorts for ports that are gone
      for (const id of linkedPorts) {
        if (!livePorts.has(id)) {
          linkedPorts.delete(id);
        }
      }
    }, 1000);
  } catch {
    console.log(
      "node-pipewire failed to load. Screen share audio will not work on linux wayland.",
    );
  }
}
