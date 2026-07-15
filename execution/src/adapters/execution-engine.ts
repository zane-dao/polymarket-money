import type { Order, OrderId, Position, RiskDecision, SignalDecision } from "../domain/index.js";

export interface PlaceOrderRequest {
  readonly signal: SignalDecision;
  readonly riskDecision: RiskDecision;
  readonly clientOrderId: string;
  readonly idempotencyKey: string;
}

export interface CancelOrderRequest {
  readonly orderId: OrderId;
  readonly reason: string;
}

export interface EmergencyExitRequest {
  readonly reason: string;
  readonly marketIds?: readonly string[];
}

/**
 * Boundary implemented by paper, shadow, or future live execution adapters.
 * This repository intentionally provides no live implementation.
 */
export interface ExecutionEngine {
  placeOrder(request: PlaceOrderRequest): Promise<Order>;
  cancelOrder(request: CancelOrderRequest): Promise<Order>;
  getOpenOrders(): Promise<readonly Order[]>;
  getPositions(): Promise<readonly Position[]>;
  emergencyExit(request: EmergencyExitRequest): Promise<readonly Order[]>;
}

