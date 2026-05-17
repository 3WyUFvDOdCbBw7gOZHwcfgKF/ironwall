export * from "./Lowering-Frontend-Shared";
export * from "./backend-linux/Backend-Linux-IR-Shared";
export * from "./Lowering-Frontend-Optimize-Program";
export * from "./Lowering-Frontend-NoOptimize-Program";
export * from "./backend-linux/Backend-Linux-Optimize-Program";
export * from "./backend-linux/Backend-Linux-NoOptimize-Program";

import type { NoOptimizeX64PassBundle } from "./backend-linux/Backend-Linux-NoOptimize-Program";
import type { OptimizedX64PassBundle } from "./backend-linux/Backend-Linux-Optimize-Program";
import type { NoOptimizeLoweringFrontendStageCResult } from "./Lowering-Frontend-NoOptimize-Program";
import type { OptimizedLoweringFrontendStageCResult } from "./Lowering-Frontend-Optimize-Program";

export type LoweringStageCResult = OptimizedLoweringFrontendStageCResult & OptimizedX64PassBundle;
export type FullNoOptimizeLoweringStageCResult = NoOptimizeLoweringFrontendStageCResult & NoOptimizeX64PassBundle;
