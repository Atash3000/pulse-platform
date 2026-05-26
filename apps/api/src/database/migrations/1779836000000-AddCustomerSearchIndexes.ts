import { MigrationInterface, QueryRunner } from "typeorm";

export class AddCustomerSearchIndexes1779836000000 implements MigrationInterface {
    name = 'AddCustomerSearchIndexes1779836000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE INDEX "IDX_customers_last_first_name" ON "customers" ("last_name", "first_name")`);
        await queryRunner.query(`CREATE INDEX "IDX_customers_nickname" ON "customers" ("nickname")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_customers_nickname"`);
        await queryRunner.query(`DROP INDEX "IDX_customers_last_first_name"`);
    }

}
