-- Per-condition pass/fail. The proportional rate does not imply it: measured at epoch 420, a provider
-- failed fast updates at 98.7% of expected, and FDC's pass line sits near 60%.
ALTER TABLE "ProviderMetricEpoch"
  ADD COLUMN "ftsoMet" BOOLEAN,
  ADD COLUMN "fdcMet"  BOOLEAN,
  ADD COLUMN "fastMet" BOOLEAN;
