namespace StarkFiRentalClient.Pages;

public class GamesPage : CatalogGridPage
{
    public GamesPage(RentalApiClient api, ClientConfig config)
        : base(api, config, "game", "No games have been added yet. Ask staff to add some from PC Rental > Café Home.")
    {
    }
}
