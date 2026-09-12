export class SingleFlightGuard {
  private activeToken: symbol | null = null;

  get busy(): boolean {
    return this.activeToken !== null;
  }

  tryBegin(): symbol | null {
    if (this.activeToken) return null;
    const token = Symbol('single-flight-operation');
    this.activeToken = token;
    return token;
  }

  begin(): symbol {
    const token = this.tryBegin();
    if (!token) throw new Error('An operation is already in progress.');
    return token;
  }

  finish(token: symbol): void {
    if (this.activeToken === token) this.activeToken = null;
  }
}
