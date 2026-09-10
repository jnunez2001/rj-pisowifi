namespace StarkFiRentalClient.Pages;

public class ApplicationsPage : CatalogGridPage
{
    public ApplicationsPage(RentalApiClient api, ClientConfig config)
        : base(api, config, "app", "No applications have been added yet. Ask staff to add some from PC Rental > Café Home.")
    {
    }
}
