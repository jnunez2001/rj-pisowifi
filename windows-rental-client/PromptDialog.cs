using System.Windows.Forms;

namespace StarkFiRentalClient;

public static class PromptDialog
{
	public static string? Show(string title, string label, bool isPassword = false, string defaultValue = "")
	{
		using Form form = new Form
		{
			Width = 360,
			Height = 160,
			Text = title,
			StartPosition = FormStartPosition.CenterScreen,
			FormBorderStyle = FormBorderStyle.FixedDialog,
			MaximizeBox = false,
			MinimizeBox = false,
			TopMost = true
		};
		Label label2 = new Label
		{
			Left = 16,
			Top = 16,
			Width = 320,
			Text = label
		};
		TextBox textBox = new TextBox
		{
			Left = 16,
			Top = 44,
			Width = 320,
			PasswordChar = (isPassword ? '*' : '\0'),
			Text = defaultValue
		};
		Button button = new Button
		{
			Text = "OK",
			Left = 176,
			Top = 80,
			Width = 80,
			DialogResult = DialogResult.OK
		};
		Button button2 = new Button
		{
			Text = "Cancel",
			Left = 264,
			Top = 80,
			Width = 72,
			DialogResult = DialogResult.Cancel
		};
		form.Controls.AddRange(new Control[4] { label2, textBox, button, button2 });
		form.AcceptButton = button;
		form.CancelButton = button2;
		return (form.ShowDialog() == DialogResult.OK) ? textBox.Text : null;
	}
}
