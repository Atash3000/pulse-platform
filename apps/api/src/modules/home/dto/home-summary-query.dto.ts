import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';

export class HomeSummaryQueryDto {
  /**
   * Optional location filter (Golden Rule #13 — every record is scoped to a
   * location_id). When present, the reorder summary only aggregates orders
   * placed at this location. Absent → all of the customer's paid orders,
   * which is what today's single-location iOS client expects.
   */
  @ApiPropertyOptional({ format: 'uuid', description: 'Scope the summary to one location.' })
  @IsOptional()
  @IsUUID()
  locationId?: string;
}
