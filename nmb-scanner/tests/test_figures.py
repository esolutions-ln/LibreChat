"""Financial figures written with thousands separators must not be mistaken for account numbers or cards."""
import pytest

from app.engine import Ctx

CTX = Ctx("conv-fig", "u1", "Wealth", ["user"])


def ents(res):
    return {f["entity"] for f in res["findings"]}


ROW = "| Net interest income | 1 234 567 890 | 1 100 000 000 |"


def test_markdown_table_row_with_grouped_figures_is_untouched(scanner):
    res = scanner.scan_text(ROW, CTX)
    assert res["decision"] == "allow"
    assert res["sanitized_content"] == ROW
    assert not ents(res)


@pytest.mark.parametrize("figure", [
    "1 234 567 890", "12 345 678 901", "123 456 789 012", "12 345 678 901 234", "1,234,567,890",
])
def test_grouped_thousands_are_not_accounts(scanner, figure):
    res = scanner.scan_text(f"Total assets {figure} for the year", CTX)
    assert "ACCOUNT_NUMBER" not in ents(res)
    assert figure in res["sanitized_content"]


@pytest.mark.parametrize("figure", ["1 234 567 890 003", "12 345 678 901 005"])
def test_grouped_figures_are_not_cards_even_when_luhn_valid(scanner, figure):
    from app.recognizers import luhn_ok
    assert luhn_ok(figure.replace(" ", ""))  # these pass the card checksum, which is the trap
    res = scanner.scan_text(f"Revenue {figure}", CTX)
    assert not ents(res)
    assert figure in res["sanitized_content"]


def test_accounts_receivable_label_does_not_turn_a_figure_into_an_account(scanner):
    res = scanner.scan_text("| Trade accounts receivable | 1 234 567 890 |", CTX)
    assert "ACCOUNT_NUMBER" not in ents(res)


def test_real_bare_account_numbers_are_still_masked(scanner):
    res = scanner.scan_text("Account number: 1234567890123", CTX)
    assert "ACCOUNT_NUMBER" in ents(res)
    assert "1234567890123" not in res["sanitized_content"]


def test_account_without_label_but_not_thousands_shaped_is_masked(scanner):
    res = scanner.scan_text("ref 1234 5678 9012", CTX)
    assert "ACCOUNT_NUMBER" in ents(res)


@pytest.mark.parametrize("label", ["Account number:", "Account no.", "Acct no", "A/C", "Beneficiary account"])
def test_explicit_account_label_still_masks_a_thousands_shaped_number(scanner, label):
    res = scanner.scan_text(f"{label} 123 456 789 012", CTX)
    assert "ACCOUNT_NUMBER" in ents(res)
    assert "123 456 789 012" not in res["sanitized_content"]


def test_real_cards_still_detected(scanner):
    assert "CREDIT_CARD" in ents(scanner.scan_text("card 4111 1111 1111 1111", CTX))
