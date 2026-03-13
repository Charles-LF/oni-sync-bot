// src/console/utils/calculator.ts
import {
  MAX_BOOSTER,
  MAX_CAPACITY,
  LIQUID_OXYGEN_EFFICIENCY,
  WEIGHTS,
  EFFECTS,
  CAPACITIES,
  ENGINE_WEIGHT_KEYS,
  CalculatorInput,
  RocketSolution,
  EngineType,
  OxygenType,
} from "./config";

// ===================== 基础工具函数 =====================
function calculateMassPenalty(weight: number): number {
  return Math.ceil(Math.max(weight, Math.pow(weight / 300, 3.2)));
}

function extractValidCounts(
  counts: Record<string, unknown>,
): Record<string, number> {
  const validCounts: Record<string, number> = {};
  for (const [key, value] of Object.entries(counts)) {
    if (typeof value === "number" && value >= 0) {
      validCounts[key] = value;
    }
  }
  return validCounts;
}

function calculateBaseDryWeight(validCounts: Record<string, number>): number {
  let baseWeight = WEIGHTS.CommandModule;
  for (const key in validCounts) {
    if (Object.prototype.hasOwnProperty.call(validCounts, key)) {
      baseWeight += (WEIGHTS[key] || 0) * validCounts[key];
    }
  }
  return baseWeight;
}

function findBestSolution(solutions: RocketSolution[]): RocketSolution[] {
  if (solutions.length === 0) return [];
  solutions.sort((a, b) => a.weight - b.weight);
  return [solutions[0]];
}

// ===================== 蒸汽引擎计算 =====================
function calculateSteamEngineRocket(
  baseDryWeight: number,
  targetDistance: number,
): RocketSolution[] {
  baseDryWeight += WEIGHTS.steamEngine;
  const allValidSolutions: RocketSolution[] = [];

  for (let boosterCount = 0; boosterCount <= MAX_BOOSTER; boosterCount++) {
    const currentDryWeight =
      baseDryWeight + WEIGHTS.SolidBooster * boosterCount;
    const boosterRange = EFFECTS.booster * boosterCount;

    for (let steamAmount = 0; steamAmount <= CAPACITIES.steam; steamAmount++) {
      const totalWeight = currentDryWeight + steamAmount;
      const totalRange = boosterRange + EFFECTS.steam * steamAmount;
      const penalty = calculateMassPenalty(totalWeight);
      const finalRange = totalRange - penalty;

      if (finalRange >= targetDistance) {
        allValidSolutions.push({
          capacity: steamAmount,
          booster: boosterCount,
          weight: totalWeight,
          mergedDistance: totalRange,
          punish: penalty,
          finalDistance: finalRange,
        });
        break;
      }
    }
  }

  return findBestSolution(allValidSolutions);
}

// ===================== 液体燃料引擎计算 =====================
interface EvaluateResult {
  isValid: boolean;
  solution?: RocketSolution;
}

function evaluateLiquidFuelConfig(
  fuelAmount: number,
  boosterCount: number,
  dryWeight: number,
  boosterRange: number,
  engineEffect: number,
  oxidizerEfficiency: number,
  targetDistance: number,
  oxygenType: OxygenType,
): EvaluateResult {
  const fuelCount = Math.ceil(fuelAmount / CAPACITIES.fuel);
  const oxygenCount = Math.ceil(fuelAmount / CAPACITIES.oxygen);
  const oxidizerTankWeight =
    oxygenType === "liquid" ? WEIGHTS.OxidizerTankLiquid : WEIGHTS.OxidizerTank;

  const totalDryWeight =
    dryWeight +
    WEIGHTS.LiquidFuelTank * fuelCount +
    oxidizerTankWeight * oxygenCount;
  const wetWeight = fuelAmount * 2;
  const totalWeight = totalDryWeight + wetWeight;
  const totalRange = Math.floor(
    boosterRange + engineEffect * fuelAmount * oxidizerEfficiency,
  );
  const penalty = calculateMassPenalty(totalWeight);
  const finalRange = totalRange - penalty;

  if (finalRange < targetDistance) return { isValid: false };

  return {
    isValid: true,
    solution: {
      capacity: fuelAmount,
      booster: boosterCount,
      fuelCount,
      oxygenCount,
      dryWeight: totalDryWeight,
      wetWeight,
      weight: totalWeight,
      mergedDistance: totalRange,
      punish: penalty,
      finalDistance: finalRange,
    },
  };
}

function calculateLiquidFuelEngineRocket(
  engineType: EngineType,
  baseDryWeight: number,
  targetDistance: number,
  oxygenType: OxygenType,
  allowWaste: boolean,
): RocketSolution[] {
  const engineEffect = EFFECTS[engineType];
  const oxidizerEfficiency =
    oxygenType === "liquid" ? LIQUID_OXYGEN_EFFICIENCY : 1;
  baseDryWeight += WEIGHTS[ENGINE_WEIGHT_KEYS[engineType]];

  const allValidSolutions: RocketSolution[] = [];

  for (let boosterCount = 0; boosterCount <= MAX_BOOSTER; boosterCount++) {
    const currentDryWeight =
      baseDryWeight + WEIGHTS.SolidBooster * boosterCount;
    const boosterRange = EFFECTS.booster * boosterCount;

    for (let fuelAmount = 0; fuelAmount <= MAX_CAPACITY; fuelAmount += 10) {
      const result = evaluateLiquidFuelConfig(
        fuelAmount,
        boosterCount,
        currentDryWeight,
        boosterRange,
        engineEffect,
        oxidizerEfficiency,
        targetDistance,
        oxygenType,
      );

      if (result.isValid) {
        allValidSolutions.push(result.solution!);
        break;
      }
    }
  }

  if (allValidSolutions.length === 0) return [];

  if (!allowWaste) {
    const uniqueMap = new Map<number, RocketSolution>();
    for (const sol of allValidSolutions) {
      const key = sol.fuelCount!;
      if (!uniqueMap.has(key) || uniqueMap.get(key)!.weight > sol.weight) {
        uniqueMap.set(key, sol);
      }
    }
    return findBestSolution(Array.from(uniqueMap.values()));
  }

  return findBestSolution(allValidSolutions);
}

// ===================== 主入口函数 =====================
export function calculateRocket(input: CalculatorInput): RocketSolution[] {
  const {
    type,
    distance: targetDistance,
    oxygenType,
    allowWaste,
    ...rawCounts
  } = input;
  const validCounts = extractValidCounts(rawCounts);
  const baseDryWeight = calculateBaseDryWeight(validCounts);

  if (type === "steam") {
    return calculateSteamEngineRocket(baseDryWeight, targetDistance);
  } else {
    return calculateLiquidFuelEngineRocket(
      type,
      baseDryWeight,
      targetDistance,
      oxygenType,
      allowWaste,
    );
  }
}
