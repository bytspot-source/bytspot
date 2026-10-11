-- CreateTable
CREATE TABLE "map_reports" (
    "id" TEXT NOT NULL,
    "reporter_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "venue_id" TEXT,
    "client_report_id" TEXT,
    "weight" INTEGER NOT NULL DEFAULT 1,
    "required_agreement" INTEGER NOT NULL DEFAULT 2,
    "confirmed_at" TIMESTAMP(3),
    "removed_at" TIMESTAMP(3),
    "points_earned" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "map_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "map_report_votes" (
    "id" TEXT NOT NULL,
    "report_id" TEXT NOT NULL,
    "voter_id" TEXT NOT NULL,
    "vote" TEXT NOT NULL,
    "weight" INTEGER NOT NULL DEFAULT 1,
    "voted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "map_report_votes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "map_reports_expires_at_lat_lng_idx" ON "map_reports"("expires_at", "lat", "lng");

-- CreateIndex
CREATE INDEX "map_reports_reporter_id_created_at_idx" ON "map_reports"("reporter_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "map_reports_venue_id_idx" ON "map_reports"("venue_id");

-- CreateIndex
CREATE UNIQUE INDEX "map_reports_reporter_id_client_report_id_key" ON "map_reports"("reporter_id", "client_report_id");

-- CreateIndex
CREATE INDEX "map_report_votes_voter_id_idx" ON "map_report_votes"("voter_id");

-- CreateIndex
CREATE UNIQUE INDEX "map_report_votes_report_id_voter_id_key" ON "map_report_votes"("report_id", "voter_id");

-- AddForeignKey
ALTER TABLE "map_reports" ADD CONSTRAINT "map_reports_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "map_reports" ADD CONSTRAINT "map_reports_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "map_report_votes" ADD CONSTRAINT "map_report_votes_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "map_reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "map_report_votes" ADD CONSTRAINT "map_report_votes_voter_id_fkey" FOREIGN KEY ("voter_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

