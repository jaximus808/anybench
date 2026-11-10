-- TDM-252 [21.12]: the price of one block of this computer at its size (the provider rate card),
-- set at create, so a 4 vCPU / 8 GiB computer costs 55,200 a block, not the flat 27,600 of
-- COMPUTER_BLOCK_PRICE_MICRO_USD. NULL (rows written before it): the flat price.
ALTER TABLE "computers" ADD COLUMN "price_per_block_micro_usd" bigint;
