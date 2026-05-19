import type { WebSocket } from "ws";

type Client = {
  ws: WebSocket;
  deviceExternalId: string;
};

export class WsHub {
  private readonly clientsByDevice = new Map<string, Set<Client>>();

  addClient(client: Client) {
    const set = this.clientsByDevice.get(client.deviceExternalId) ?? new Set<Client>();
    set.add(client);
    this.clientsByDevice.set(client.deviceExternalId, set);
  }

  removeClient(ws: WebSocket) {
    for (const [deviceExternalId, set] of this.clientsByDevice.entries()) {
      for (const client of set) {
        if (client.ws === ws) set.delete(client);
      }
      if (set.size === 0) this.clientsByDevice.delete(deviceExternalId);
    }
  }

  publish(deviceExternalId: string, message: unknown) {
    const payload = JSON.stringify(message);

    const targetSets = [this.clientsByDevice.get(deviceExternalId), this.clientsByDevice.get("all")].filter(
      (s): s is Set<Client> => Boolean(s)
    );

    for (const set of targetSets) {
      for (const client of set) {
        if (client.ws.readyState === client.ws.OPEN) client.ws.send(payload);
      }
    }
  }
}
