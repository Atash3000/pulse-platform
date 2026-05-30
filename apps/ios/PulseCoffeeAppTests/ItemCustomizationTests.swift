import XCTest
@testable import PulseCoffeeApp

final class ItemCustomizationTests: XCTestCase {

    // MARK: - Fixtures

    private func mod(_ id: String, _ name: String, _ priceCents: Int = 0, _ sort: Int = 0) -> Modifier {
        Modifier(id: id, name: name, priceCents: priceCents, sortOrder: sort)
    }

    private func group(
        _ id: String, _ name: String,
        required: Bool, multiSelect: Bool, sort: Int = 0,
        modifiers: [Modifier]
    ) -> ModifierGroup {
        ModifierGroup(id: id, name: name, required: required,
                      multiSelect: multiSelect, sortOrder: sort, modifiers: modifiers)
    }

    private func item(basePriceCents: Int = 645, groups: [ModifierGroup] = []) -> MenuItem {
        MenuItem(id: "matcha", name: "Strawberry Matcha", description: "Three flavors in one cup.",
                 basePriceCents: basePriceCents, imageURL: nil, available: true,
                 quantityLeft: nil, modifierGroups: groups)
    }

    // A required single-select Size group (12oz default-ish first, 16oz +50, 20oz +100).
    private var sizeGroup: ModifierGroup {
        group("size", "Size", required: true, multiSelect: false, sort: 0, modifiers: [
            mod("s12", "12oz", 0, 0), mod("s16", "16oz", 50, 1), mod("s20", "20oz", 100, 2),
        ])
    }
    // An optional multi-select Extras group.
    private var extrasGroup: ModifierGroup {
        group("extras", "Extras", required: false, multiSelect: true, sort: 1, modifiers: [
            mod("shot", "Extra shot", 75, 0), mod("foam", "Cold foam", 65, 1),
        ])
    }

    // MARK: - Pricing

    func test_displayPrice_isBasePlusSelectedDeltas() {
        var c = ItemCustomization(item: item(basePriceCents: 645, groups: [sizeGroup, extrasGroup]))
        c.toggle(modifierId: "s20", in: sizeGroup)   // +100
        c.toggle(modifierId: "shot", in: extrasGroup) // +75
        c.toggle(modifierId: "foam", in: extrasGroup) // +65
        XCTAssertEqual(c.displayPriceCents, 645 + 100 + 75 + 65)
    }

    func test_zeroDeltaModifier_doesNotChangePrice() {
        var c = ItemCustomization(item: item(basePriceCents: 645, groups: [sizeGroup]))
        c.toggle(modifierId: "s12", in: sizeGroup) // +0
        XCTAssertEqual(c.displayPriceCents, 645)
    }

    // MARK: - Selection rules

    func test_singleSelect_replacesPriorSelectionInGroup() {
        var c = ItemCustomization(item: item(groups: [sizeGroup]))
        c.toggle(modifierId: "s16", in: sizeGroup)
        c.toggle(modifierId: "s20", in: sizeGroup)
        XCTAssertTrue(c.isSelected("s20", in: sizeGroup))
        XCTAssertFalse(c.isSelected("s16", in: sizeGroup))
    }

    func test_multiSelect_togglesIndependently() {
        var c = ItemCustomization(item: item(groups: [extrasGroup]))
        c.toggle(modifierId: "shot", in: extrasGroup)
        c.toggle(modifierId: "foam", in: extrasGroup)
        XCTAssertTrue(c.isSelected("shot", in: extrasGroup))
        XCTAssertTrue(c.isSelected("foam", in: extrasGroup))
        c.toggle(modifierId: "shot", in: extrasGroup) // toggle off
        XCTAssertFalse(c.isSelected("shot", in: extrasGroup))
        XCTAssertTrue(c.isSelected("foam", in: extrasGroup))
    }

    // MARK: - Required-group validation

    func test_defaultSelection_preselectsCheapestRequiredSingleSelect() {
        let c = ItemCustomization(item: item(groups: [sizeGroup]))
        XCTAssertTrue(c.isSelected("s12", in: sizeGroup)) // first by sortOrder AND cheapest (0 cents)
        XCTAssertTrue(c.isSatisfied)
    }

    func test_defaultSelection_preselectsCheapestNotFirstBySortOrder() {
        // Oat (+75) is sort 0 (renders first); Whole (0) is sort 1. Default
        // must be the cheapest (Whole), not the first by sortOrder.
        let milk = group("milk", "Milk", required: true, multiSelect: false, sort: 0, modifiers: [
            mod("oat", "Oat", 75, 0),
            mod("whole", "Whole", 0, 1),
            mod("almond", "Almond", 75, 2),
        ])
        let item = self.item(basePriceCents: 645, groups: [milk])
        let c = ItemCustomization(item: item)
        XCTAssertTrue(c.isSelected("whole", in: milk))
        XCTAssertFalse(c.isSelected("oat", in: milk))
        XCTAssertEqual(c.displayPriceCents, 645) // opens at base price, no premium default
        XCTAssertTrue(c.isSatisfied)
    }

    func test_requiredMultiSelect_startsEmpty_andBlocksUntilChosen() {
        let req = group("syrup", "Syrup", required: true, multiSelect: true, modifiers: [
            mod("van", "Vanilla", 50, 0), mod("haz", "Hazelnut", 50, 1),
        ])
        var c = ItemCustomization(item: item(groups: [req]))
        XCTAssertFalse(c.isSatisfied)
        XCTAssertEqual(c.firstUnsatisfiedGroupName, "Syrup")
        c.toggle(modifierId: "van", in: req)
        XCTAssertTrue(c.isSatisfied)
    }

    func test_optionalGroup_doesNotBlockCTA() {
        let c = ItemCustomization(item: item(groups: [extrasGroup])) // optional only
        XCTAssertTrue(c.isSatisfied)
        XCTAssertNil(c.firstUnsatisfiedGroupName)
    }

    func test_emptyModifierGroups_isSatisfied_andPriceIsBase() {
        let c = ItemCustomization(item: item(basePriceCents: 500, groups: []))
        XCTAssertTrue(c.isSatisfied)
        XCTAssertEqual(c.displayPriceCents, 500)
        XCTAssertTrue(c.selectedModifierIds.isEmpty)
    }

    func test_selectedModifierIds_matchesActivePills() {
        var c = ItemCustomization(item: item(groups: [sizeGroup, extrasGroup]))
        c.toggle(modifierId: "s16", in: sizeGroup)
        c.toggle(modifierId: "shot", in: extrasGroup)
        XCTAssertEqual(Set(c.selectedModifierIds), ["s16", "shot"])
    }
}
