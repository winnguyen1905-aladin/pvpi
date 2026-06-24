import { Ed25519Key } from "../types/ed25519-key.ts";
import { Party } from "./party.model.ts";

// Roles B / C: hold a private local value (the gradient secret, bounded by y_max).
export class Trainer extends Party {
  secret: number;

  constructor(name: string, secret: number, key: Ed25519Key = Ed25519Key.generate(), id: string = name) {
    super(name, key, id);
    this.secret = secret;
  }
}