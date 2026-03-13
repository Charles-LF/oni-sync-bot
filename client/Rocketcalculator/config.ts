// ===================== 常量定义 =====================
export const MAX_BOOSTER = 10;
export const MAX_CAPACITY = 20000;
export const LIQUID_OXYGEN_EFFICIENCY = 1.33;

// ===================== 类型定义 =====================
export type EngineType = "steam" | "oil" | "hydrogen" | "biodiesel";
export type OxygenType = "liquid" | "solid";

export interface ModuleWeights {
  steamEngine: number;
  oilEngine: number;
  hydrogenEngine: number;
  biodieselEngine: number;
  CommandModule: number;
  RoboPilotCommandModule: number;
  SolidBooster: number;
  LiquidFuelTank: number;
  OxidizerTank: number;
  OxidizerTankLiquid: number;
  CargoBay: number;
  GasCargoBay: number;
  LiquidCargoBay: number;
  SpecialCargoBay: number;
  TouristModule: number;
  ResearchModule: number;
  [key: string]: number;
}

export interface EngineEffects {
  steam: number;
  oil: number;
  hydrogen: number;
  biodiesel: number;
  booster: number;
}

export interface StorageCapacities {
  steam: number;
  fuel: number;
  oxygen: number;
}

export interface CalculatorInput {
  type: EngineType;
  distance: number;
  oxygenType: OxygenType;
  allowWaste: boolean;
  [key: string]: any;
}

export interface RocketSolution {
  capacity: number;
  booster: number;
  weight: number;
  mergedDistance: number;
  punish: number;
  finalDistance: number;
  dryWeight?: number;
  wetWeight?: number;
  fuelCount?: number;
  oxygenCount?: number;
}

// ===================== 游戏数据 =====================
export const WEIGHTS: ModuleWeights = {
  steamEngine: 2000,
  oilEngine: 200,
  hydrogenEngine: 500,
  biodieselEngine: 200,
  CommandModule: 200,
  RoboPilotCommandModule: 200,
  SolidBooster: 1000,
  LiquidFuelTank: 100,
  OxidizerTank: 100,
  OxidizerTankLiquid: 100,
  CargoBay: 2000,
  GasCargoBay: 2000,
  LiquidCargoBay: 2000,
  SpecialCargoBay: 2000,
  TouristModule: 200,
  ResearchModule: 200,
  person: 30,
};

export const EFFECTS: EngineEffects = {
  steam: 20,
  oil: 40,
  hydrogen: 60,
  biodiesel: 50,
  booster: 12000,
};

export const CAPACITIES: StorageCapacities = {
  steam: 900,
  fuel: 900,
  oxygen: 2700,
};

export const ENGINE_WEIGHT_KEYS: Record<EngineType, keyof ModuleWeights> = {
  steam: "steamEngine",
  oil: "oilEngine",
  hydrogen: "hydrogenEngine",
  biodiesel: "biodieselEngine",
};

// 模块显示名称映射
export const MODULE_LABELS: Record<string, string> = {
  ResearchModule: "研究舱",
  CargoBay: "固体货舱",
  GasCargoBay: "气体货舱",
  LiquidCargoBay: "液体货舱",
  SpecialCargoBay: "生物货舱",
  TouristModule: "观光舱",
  RoboPilotCommandModule: "机器驾驶舱",
};
